'use strict';

/**
 * Classic phone path: Twilio PCM → Flux → orchestrator → Gemini text+RAG → ElevenLabs → mixer → Twilio.
 * Gemini Live remains available when VOICE_PIPELINE=live.
 */

const { env } = require('../config/env');
const logger = require('../utils/logger');
const dashboardSocket = require('../websocket/dashboardSocket');
const agentService = require('../services/agentService');
const { buildGreetingInstruction, buildSystemInstruction } = require('../config/prompts');
const { DEFAULT_TIMEZONE } = require('../utils/timeOfDay');
const { evaluateWaitHoldAck } = require('../utils/waitAckSafety');
const { mulaw8kToPcm16k } = require('../utils/audioCodec');
const {
  createSpeechGateState,
  evaluateFrame,
  isBargeInConfirmed,
} = require('../utils/speechGate');
const { createFluxClient } = require('./deepgramFluxClient');
const { synthesizePcm24k, splitSpeakableSentences } = require('./elevenLabsTts');
const { mixPcm16 } = require('./audioMixer');
const { answerWithKnowledge } = require('./classicLlm');
const { decideTurn, appendTurnCtrl, ECHO_GUARD_MS } = require('./conversationOrchestrator');

const HOLD_ACK = 'Yeah, no rush.';
const MID_CALL_GREETING_ACK = 'Hey — what can I help with?';

function isClassicPipeline() {
  return env.voicePipeline === 'classic';
}

function liveSessionApi() {
  return require('../services/liveCallSession');
}

function ensureGate(session) {
  if (!session.speechGate) {
    session.speechGate = createSpeechGateState();
  }
  return session.speechGate;
}

async function loadPrompt(session, options = {}) {
  const midCall = Boolean(options.midCall);
  if (
    session.agentPrompt &&
    session.classicSystemInstruction &&
    session.classicPromptMidCall === midCall
  ) {
    return session.classicSystemInstruction;
  }
  // Prefer thin wrapper already loaded via loadAgentOntoSession (dashboard name + policies).
  let base = String(session.agentPrompt || '').trim();
  if (!base) {
    const agent = await agentService.requireAgentForCall();
    base = agentService.buildAgentSystemInstruction(agent);
    session.agentPrompt = base;
    session.agentName = String((agent && agent.name) || 'Assistant');
  } else if (!session.agentName) {
    session.agentName = 'Assistant';
  }
  session.classicPromptMidCall = midCall;
  session.classicSystemInstruction = buildSystemInstruction(
    base,
    new Date(),
    DEFAULT_TIMEZONE,
    {
      midCall,
      channelLabel:
        'Twilio phone call via classic pipeline (Deepgram STT → Gemini text → ElevenLabs TTS)',
    }
  );
  return session.classicSystemInstruction;
}

function buildGreetingKick(session) {
  const name = String(session.agentName || 'Assistant').trim() || 'Assistant';
  return `${buildGreetingInstruction()}

Open the call now.
Your spoken name is exactly "${name}" from dashboard Agent Configuration — do not invent another name.
For company/business name or why you are calling: call searchKnowledge first; only mention company details found in snippets. If search returns nothing useful, greet with your name only and ask how you can help — do not invent a company.
Speak 1–3 warm conversational sentences. Vapi-style: natural, not scripted. No markdown.`;
}

function cancelInFlight(session) {
  if (session && session.classicAbort) {
    try {
      session.classicAbort.abort();
    } catch {
      // ignore
    }
  }
  if (session) {
    session.classicAbort = new AbortController();
    session.aiSpeaking = false;
  }
}

async function playMixed(session, pcm24k) {
  if (!pcm24k || !pcm24k.length || !session || session.ending) return;
  const mixed = mixPcm16(pcm24k, {
    enabled: env.outboundAmbienceEnabled,
    gain: session.aiSpeaking ? env.outboundAmbienceGain : Math.min(0.25, env.outboundAmbienceGain * 2),
    cursor: session.ambienceCursor || 0,
  });
  session.ambienceCursor = mixed.cursor;
  if (!session.classicTtsFirstAt) {
    session.classicTtsFirstAt = Date.now();
    logClassicLatency(session, 'tts_first_byte');
  }
  liveSessionApi().playGeminiPcmOnce(
    session,
    mixed.pcm,
    session.playbackGeneration || 0
  );
}

function logClassicLatency(session, step) {
  if (!session) return;
  const eot = session.classicEotAt || 0;
  const llm = session.classicLlmFirstAt || 0;
  const tts = session.classicTtsFirstAt || 0;
  logger.info(
    'LATENCY',
    `[CLASSIC_LATENCY] callSid=${session.callSid} step=${step}` +
      ` eot_to_llm_ms=${eot && llm ? llm - eot : -1}` +
      ` llm_to_tts_ms=${llm && tts ? tts - llm : -1}`
  );
}

async function speakText(session, text) {
  const sentences = splitSpeakableSentences(text);
  session.aiSpeaking = true;
  const signal = session.classicAbort && session.classicAbort.signal;
  for (const sentence of sentences) {
    if (!session || session.ending || (signal && signal.aborted)) break;
    const pcm = await synthesizePcm24k(sentence, { signal });
    if (signal && signal.aborted) break;
    await playMixed(session, pcm);
  }
  session.aiSpeaking = false;
}

async function handleCallerFinal(session, text) {
  const { decision, action } = decideTurn(session, text);
  appendTurnCtrl(session, decision, action);
  session.classicEotAt = Date.now();
  if (action === 'DROP' || action === 'SKIP_BACKCHANNEL' || action === 'KEEP_LISTENING') {
    return;
  }
  const live = liveSessionApi();

  // WAIT: stop LLM/TTS and clear Twilio before arming hold (matches dashboard Waiting).
  if (action === 'ENTER_WAIT') {
    cancelInFlight(session);
    live.clearTwilioPlayback(session);
    await live.onCallerUtterance(session, decision.text || text);
    if (session.waitAckBudget > 0) {
      const verdict = evaluateWaitHoldAck(HOLD_ACK);
      if (verdict.ok) {
        try {
          const pcm = await synthesizePcm24k(HOLD_ACK);
          await playMixed(session, pcm);
        } catch (error) {
          logger.warn('CLASSIC', `wait ack tts: ${error.message}`);
        }
        session.waitAckBudget = 0;
      }
    }
    return;
  }

  await live.onCallerUtterance(session, decision.text || text);
  if (session.waiting) return;
  if (action === 'ACK_ONLY') {
    await speakFixedAck(session, MID_CALL_GREETING_ACK);
    return;
  }
  await answerCaller(session, decision.text || text);
}

function emitAssistantTurn(session, spoken) {
  const text = String(spoken || '').trim();
  if (!session || !text) return;
  if (!Array.isArray(session.history)) session.history = [];
  session.history.push({ role: 'assistant', content: text });
  dashboardSocket.broadcast({
    type: 'AI_RESPONSE',
    data: { callSid: session.callSid, content: text },
  });
  liveSessionApi().saveMessage(session.callSid, 'assistant', text).catch(() => {});
}

function emitAiProcessing(session) {
  if (!session || !session.callSid) return;
  dashboardSocket.broadcast({
    type: 'AI_PROCESSING',
    data: { callSid: session.callSid },
  });
}

async function speakFixedAck(session, text) {
  // Only cancel prior speech/LLM — avoid resetting a fresh controller for no reason.
  if (session.aiSpeaking) {
    cancelInFlight(session);
    liveSessionApi().clearTwilioPlayback(session);
  } else if (!session.classicAbort) {
    session.classicAbort = new AbortController();
  }
  const spoken = String(text || '').trim();
  if (!spoken) return;
  emitAssistantTurn(session, spoken);
  try {
    await speakText(session, spoken);
  } catch (error) {
    if (!(session.classicAbort && session.classicAbort.signal.aborted)) {
      logger.error('CLASSIC', `ack tts: ${error.message}`);
    }
  }
}

async function answerCaller(session, userText, options = {}) {
  cancelInFlight(session);
  liveSessionApi().clearTwilioPlayback(session);
  emitAiProcessing(session);
  if (!session.classicAbort) session.classicAbort = new AbortController();
  const signal = session.classicAbort.signal;
  const midCall =
    options.midCall != null
      ? Boolean(options.midCall)
      : Boolean(session.greeted) ||
        (Array.isArray(session.history) &&
          session.history.some((m) => m && m.role === 'assistant'));
  const systemInstruction = await loadPrompt(session, { midCall });
  const history = (session.history || []).slice(0, -1);
  let spoken = '';
  try {
    spoken = await answerWithKnowledge({
      systemInstruction,
      history,
      userText,
      waiting: Boolean(session.waiting),
      signal,
      forceKnowledge: Boolean(options.forceKnowledge),
    });
  } catch (error) {
    if (signal.aborted) return;
    logger.error('CLASSIC', `llm: ${error.message}`);
    return;
  }
  if (!spoken || (signal && signal.aborted) || session.waiting) return;
  session.classicLlmFirstAt = Date.now();
  logClassicLatency(session, 'llm_first_token');
  emitAssistantTurn(session, spoken);
  try {
    await speakText(session, spoken);
  } catch (error) {
    if (!signal.aborted) logger.error('CLASSIC', `tts: ${error.message}`);
  }
}

function onBargeIn(session) {
  if (!session || session.pipeline !== 'classic') return;
  const confirmed = isBargeInConfirmed(session.speechGate, {
    nowMs: Date.now(),
    confirmWindowMs: Number(env.bargeInConfirmWindowMs) || 480,
  });
  if (!confirmed || !session.aiSpeaking) return;
  logger.info('LIVE', `[BARGE_IN_CONFIRMED] callSid=${session.callSid} pipeline=classic`);
  cancelInFlight(session);
  liveSessionApi().clearTwilioPlayback(session);
}

function forwardClassicMedia(session, payloadBase64) {
  if (!session || !session.forwardAudio || !session.flux) return;
  const mulaw = Buffer.from(payloadBase64, 'base64');
  const pcm16k = mulaw8kToPcm16k(mulaw);
  const gate = ensureGate(session);
  const decision = evaluateFrame(pcm16k, gate, {
    aiSpeaking: Boolean(session.aiSpeaking),
    nowMs: Date.now(),
  });
  if (decision.accept && session.aiSpeaking) {
    onBargeIn(session);
  }
  session.flux.sendPcm(pcm16k);
  session.geminiInCount = (session.geminiInCount || 0) + 1;
}

function bindFlux(session, flux) {
  session.flux = flux;
  session.pipeline = 'classic';
  session.classicAbort = new AbortController();
  let lastFinal = '';
  flux.on('endOfTurn', (evt) => {
    const text = String((evt && evt.text) || '').trim();
    if (!text || text === lastFinal) return;
    lastFinal = text;
    handleCallerFinal(session, text).catch((error) => {
      logger.error('CLASSIC', `turn: ${error.message}`);
    });
  });
  flux.on('error', (error) => {
    logger.error('FLUX', error && error.message ? error.message : 'flux error');
  });
}

async function attachClassic(session) {
  session.pipeline = 'classic';
  session.liveSession = { classic: true };
  if (!session.flux) {
    bindFlux(session, createFluxClient());
  }
  // After Twilio Play of primed greeting, ignore early Flux echo.
  if (
    session.greeted &&
    (session.greetingPlayedViaTwiml || session.greetingClipReady)
  ) {
    session.classicEchoGuardUntil = Date.now() + ECHO_GUARD_MS;
  }
  if (!session.greeted) {
    session.greeted = true;
    await loadPrompt(session, { midCall: false });
    await answerCaller(session, buildGreetingKick(session), {
      midCall: false,
      forceKnowledge: true,
    });
  }
  logger.info('CLASSIC', `attached callSid=${session.callSid}`);
  return session;
}

async function primeClassic(session, atDial) {
  session.pipeline = 'classic';
  session.liveSession = { classic: true, atDial: Boolean(atDial) };
  // Answer FALLBACK can race dial prime — never open twice.
  if (
    session.greeted &&
    Array.isArray(session.history) &&
    session.history.some((m) => m && m.role === 'assistant')
  ) {
    logger.info(
      'CLASSIC',
      `greeting prime skipped already greeted callSid=${session.callSid} atDial=${Boolean(atDial)}`
    );
    return session;
  }
  // Do not cancelInFlight while this session is the shared in-flight prime — joining
  // answer FALLBACK must not abort dial LLM/TTS.
  if (!session.classicAbort) {
    session.classicAbort = new AbortController();
  }
  const systemInstruction = await loadPrompt(session, { midCall: false });
  emitAiProcessing(session);
  const spoken = await answerWithKnowledge({
    systemInstruction,
    history: [],
    userText: buildGreetingKick(session),
    waiting: false,
    signal: session.classicAbort.signal,
    forceKnowledge: true,
  });
  if (!spoken) return session;
  // Another concurrent prime may have finished while we awaited LLM/TTS.
  if (
    session.greeted &&
    Array.isArray(session.history) &&
    session.history.some((m) => m && m.role === 'assistant')
  ) {
    logger.info(
      'CLASSIC',
      `greeting prime aborted duplicate callSid=${session.callSid}`
    );
    return session;
  }
  const pcm = await synthesizePcm24k(spoken);
  const mixed = mixPcm16(pcm, {
    enabled: env.outboundAmbienceEnabled,
    gain: env.outboundAmbienceGain,
    cursor: 0,
  });
  session.ambienceCursor = mixed.cursor;
  if (!Array.isArray(session.pendingOutboundPcm)) session.pendingOutboundPcm = [];
  session.pendingOutboundPcm.push({ pcm: mixed.pcm, gen: session.playbackGeneration || 0 });
  emitAssistantTurn(session, spoken);
  session.greeted = true;
  liveSessionApi().maybeFinalizeOutboundGreetingClip(session);
  logger.info(
    'CLASSIC',
    `greeting primed callSid=${session.callSid} atDial=${Boolean(atDial)} chars=${spoken.length}`
  );
  return session;
}

function closeClassic(session) {
  if (!session || session.pipeline !== 'classic') return;
  cancelInFlight(session);
  if (session.flux) {
    session.flux.close();
    session.flux = null;
  }
}

module.exports = {
  isClassicPipeline,
  attachClassic,
  primeClassic,
  forwardClassicMedia,
  closeClassic,
  onBargeIn,
  handleCallerFinal,
  HOLD_ACK,
  MID_CALL_GREETING_ACK,
};
