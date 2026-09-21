'use strict';

const fs = require('fs');
const path = require('path');
const { Message } = require('../models/Message');
const { isDatabaseConnected } = require('../config/database');
const callService = require('./callService');
const agentService = require('./agentService');
const knowledgeService = require('./knowledgeService');
const { env } = require('../config/env');
const dashboardSocket = require('../websocket/dashboardSocket');
const geminiLiveService = require('./geminiLiveService');
const { isWaitHold, isResume } = require('../utils/waitIntent');
const {
  mulaw8kToPcm16k,
  pcm24kToMulaw8k,
  chunkMulawForTwilio,
  TWILIO_FRAME_BYTES,
} = require('../utils/audioCodec');
const {
  createSpeechGateState,
  shouldForward,
} = require('../utils/speechGate');
const { buildGreetingInstruction } = require('../config/prompts');
const logger = require('../utils/logger');

/** @type {Map<string, object>} */
const sessions = new Map();

const LATENCY_LOG_PATH = path.join(__dirname, '../../logs/latency-latest.log');

/** Max Gemini reconnect attempts per failure streak (resets on success). */
const LIVE_RECONNECT_MAX_ATTEMPTS = 5;
/** Base backoff for reconnect (ms); doubles each attempt up to max. */
const LIVE_RECONNECT_BASE_MS = 500;
const LIVE_RECONNECT_MAX_MS = 8000;

/** @type {() => number} */
let clockFn = () => Date.now();

function nowMs() {
  return clockFn();
}

/** Test-only: inject clock. Pass null/undefined to restore Date.now. */
function setNowMsForTests(fn) {
  clockFn = typeof fn === 'function' ? fn : () => Date.now();
}

function elapsedMs(session) {
  if (!session || !session.t0) return 0;
  return nowMs() - session.t0;
}

/**
 * Truncate latency-latest.log on backend startup so each server run starts
 * clean. Does not touch any other log files. Mid-session entries are kept.
 */
function clearLatencyLogOnStartup() {
  try {
    const dir = path.dirname(LATENCY_LOG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(LATENCY_LOG_PATH, '', 'utf8');
    logger.info('LATENCY', `Cleared ${LATENCY_LOG_PATH} for fresh server run`);
  } catch (error) {
    logger.warn('LATENCY', `Failed to clear latency log: ${error.message}`);
  }
}

/**
 * Clear AI-reply outbound latency stamps so the next model turn can measure
 * again. Does not clear lastSpeechAudioAt / geminiUserTurnCompleteAt.
 *
 * Important: does NOT clear latencyBreakdownLogged. Clearing that flag here
 * caused later turns to skip beginNewUserLatencyWindow and reuse a stale
 * geminiUserTurnCompleteAt (A=0ms, huge B, while TOTAL stayed ~700ms).
 */
function resetOutboundReplyStamps(session) {
  if (!session) return;
  session.turnGeminiFirstAudioAt = null;
  session.firstAudioTurnSeq = null;
  session.turnTwilioFirstSendAt = null;
  session.twilioSendTurnSeq = null;
  session.latencyBreakdownIncompleteLogged = false;
}

/**
 * Start a new user-activity measurement window (after a completed breakdown
 * or when the caller speaks again after an AI turn).
 * Increments latencyTurnSeq so stamps cannot leak across turns.
 */
function beginNewUserLatencyWindow(session) {
  if (!session) return;
  session.latencyTurnSeq = (session.latencyTurnSeq || 0) + 1;
  session.speechTurnSeq = null;
  session.turnCompleteTurnSeq = null;
  session.geminiUserTurnCompleteAt = null;
  session.latencyBreakdownLogged = false;
  resetOutboundReplyStamps(session);
}

function logBreakdownIncomplete(session, reason, stamps) {
  if (!session || session.latencyBreakdownIncompleteLogged) {
    return;
  }
  session.latencyBreakdownIncompleteLogged = true;
  const message =
    `breakdown_incomplete call=${session.callSid} reason=${reason}` +
    ` has_speech=${stamps.userStop != null}` +
    ` has_turn_complete=${stamps.turnComplete != null}` +
    ` has_first_audio=${stamps.firstAudio != null}` +
    ` has_twilio_send=${stamps.twilioSend != null}` +
    (stamps.turnSeq != null ? ` turnSeq=${stamps.turnSeq}` : '');
  logger.info('LATENCY', message);
  appendLatencyLogLine(`${new Date(nowMs()).toISOString()} LATENCY ${message}`);
}

function appendLatencyLogLine(line) {
  try {
    const dir = path.dirname(LATENCY_LOG_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(LATENCY_LOG_PATH, `${line}\n`, 'utf8');
  } catch (error) {
    logger.warn('LATENCY', `Failed to append latency log: ${error.message}`);
  }
}

/**
 * True when all four latency stamps share one latencyTurnSeq (no cross-turn leak).
 */
function latencyStampsSameTurn(session) {
  const seq = session.latencyTurnSeq;
  if (seq == null || seq < 1) {
    return false;
  }
  return (
    session.speechTurnSeq === seq &&
    session.turnCompleteTurnSeq === seq &&
    session.firstAudioTurnSeq === seq &&
    session.twilioSendTurnSeq === seq
  );
}

/**
 * Log one LATENCY_BREAKDOWN line when all measured stamps exist and belong
 * to the same turn (same turnSeq + chronological + A+B+C === TOTAL).
 * Otherwise logs breakdown_incomplete — never invents or clamps deltas.
 */
function maybeLogLatencyBreakdown(session) {
  if (!session || session.latencyBreakdownLogged) {
    return false;
  }
  const userStop = session.lastSpeechAudioAt;
  const turnComplete = session.geminiUserTurnCompleteAt;
  const firstAudio = session.turnGeminiFirstAudioAt;
  const twilioSend = session.turnTwilioFirstSendAt;
  const stamps = {
    userStop,
    turnComplete,
    firstAudio,
    twilioSend,
    turnSeq: session.latencyTurnSeq,
  };
  if (
    userStop == null ||
    turnComplete == null ||
    firstAudio == null ||
    twilioSend == null
  ) {
    return false;
  }

  // Stamps must belong to the same user/AI turn window.
  if (!latencyStampsSameTurn(session)) {
    logBreakdownIncomplete(session, 'turn_mismatch', stamps);
    return false;
  }

  // Required order: lastSpeech <= turnComplete <= firstAudio <= twilioSend
  if (
    !(
      userStop <= turnComplete &&
      turnComplete <= firstAudio &&
      firstAudio <= twilioSend
    )
  ) {
    logBreakdownIncomplete(session, 'stamp_order', stamps);
    return false;
  }

  const user_stop_to_gemini_turn_complete = turnComplete - userStop;
  const gemini_turn_complete_to_first_audio = firstAudio - turnComplete;
  const first_audio_to_twilio_send = twilioSend - firstAudio;
  const TOTAL_user_stop_to_twilio_send = twilioSend - userStop;
  const partsSum =
    user_stop_to_gemini_turn_complete +
    gemini_turn_complete_to_first_audio +
    first_audio_to_twilio_send;

  if (
    user_stop_to_gemini_turn_complete < 0 ||
    gemini_turn_complete_to_first_audio < 0 ||
    first_audio_to_twilio_send < 0 ||
    partsSum !== TOTAL_user_stop_to_twilio_send
  ) {
    logBreakdownIncomplete(session, 'parts_neq_total', stamps);
    return false;
  }

  session.latencyBreakdownLogged = true;
  const message =
    `call=${session.callSid} turn=${session.latencyTurnSeq} model=${env.geminiLiveModel} user_stop_to_gemini_turn_complete=${user_stop_to_gemini_turn_complete}ms gemini_turn_complete_to_first_audio=${gemini_turn_complete_to_first_audio}ms first_audio_to_twilio_send=${first_audio_to_twilio_send}ms TOTAL_user_stop_to_twilio_send=${TOTAL_user_stop_to_twilio_send}ms`;
  logger.info('LATENCY_BREAKDOWN', message);
  appendLatencyLogLine(
    `${new Date(nowMs()).toISOString()} LATENCY_BREAKDOWN ${message}`
  );
  return true;
}

/**
 * Associate caller speech with exactly one latency turn window.
 *
 * stamp_order root cause: after Gemini fired userActivityEnd we still updated
 * lastSpeechAudioAt on later speech-like frames (echo/noise/continued talk),
 * so userStop moved past turnComplete while firstAudio/twilioSend belonged to
 * the in-flight reply → all four stamps present but out of chronological order.
 *
 * Rules:
 * - After a completed/incomplete breakdown → open a new turn window.
 * - After turnComplete is set for the open window → freeze lastSpeechAudioAt
 *   (do not move user-stop past turnComplete).
 * - Otherwise keep updating lastSpeechAudioAt as the user-stop candidate.
 */
function stampCallerSpeechForLatency(session, t) {
  if (!session) return;

  if (session.latencyBreakdownLogged || session.latencyBreakdownIncompleteLogged) {
    beginNewUserLatencyWindow(session);
    session.lastSpeechAudioAt = t;
    session.speechTurnSeq = session.latencyTurnSeq;
    return;
  }

  // Gemini already closed this user turn — freeze stop time for this window.
  if (session.geminiUserTurnCompleteAt != null) {
    return;
  }

  if (!session.latencyTurnSeq) {
    beginNewUserLatencyWindow(session);
  }
  session.lastSpeechAudioAt = t;
  session.speechTurnSeq = session.latencyTurnSeq;
}

function getSession(callSid) {
  return callSid ? sessions.get(callSid) : null;
}

function getSessionByWs(ws) {
  for (const session of sessions.values()) {
    if (session.twilioWs === ws) {
      return session;
    }
  }
  return null;
}

function createEmptySession(callSid, twilioWs, streamSid, from, to) {
  return {
    callSid,
    streamSid,
    twilioWs,
    liveSession: null,
    liveSessionEpoch: 0,
    /** Latest Gemini Live sessionResumptionUpdate.newHandle for this call. */
    resumptionHandle: null,
    /** True while a Gemini reconnect/resume is in flight. */
    reconnecting: false,
    /** Consecutive failed reconnect attempts (reset on success). */
    reconnectAttempts: 0,
    /** Pending delayed reconnect timer. */
    reconnectTimer: null,
    history: [],
    historyLoaded: true,
    waiting: false,
    forwardAudio: true,
    inputTranscriptBuffer: '',
    outputTranscriptBuffer: '',
    outboundRemainder: Buffer.alloc(0),
    playbackGeneration: 0,
    geminiChunkCount: 0,
    twilioFrameCount: 0,
    inboundMediaCount: 0,
    gatedDropCount: 0,
    speechLabeledCount: 0,
    geminiInCount: 0,
    gateWarnLogged: false,
    from: from || null,
    to: to || null,
    greeted: false,
    connecting: false,
    ending: false,
    /** Mongo Agent id for this call (set at start). */
    agentId: null,
    agentName: null,
    /** Combined Agent.prompts — reused on reconnect; never reloaded mid-call. */
    agentPrompt: null,
    aiSpeaking: false,
    suppressStaleOutput: false,
    speechGate: createSpeechGateState(),
    t0: nowMs(),
    lastCallerAudioAt: null,
    lastGeminiInAt: null,
    firstGeminiAudioAt: null,
    firstTwilioOutAt: null,
    interruptAt: null,
    clearAt: null,
    lastUserTurnEndAt: null,
    lastSpeechAudioAt: null,
    geminiUserTurnCompleteAt: null,
    turnGeminiFirstAudioAt: null,
    turnTwilioFirstSendAt: null,
    /** Monotonic turn id for latency stamp association (starts at 0; first speech → 1). */
    latencyTurnSeq: 0,
    speechTurnSeq: null,
    turnCompleteTurnSeq: null,
    firstAudioTurnSeq: null,
    twilioSendTurnSeq: null,
    latencyBreakdownLogged: false,
    latencyBreakdownIncompleteLogged: false,
    turnFirstAudioLogged: false,
    /** Correlates MULTILINGUAL_DEBUG caller/assistant transcript pairs. */
    debugTurnSeq: 0,
  };
}

async function saveMessage(callSid, role, content) {
  if (!isDatabaseConnected() || !callSid || !content) {
    return null;
  }
  try {
    return await Message.create({
      callSid,
      role,
      content,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('CALL', `Message save failed: ${error.message}`);
    return null;
  }
}

function pushHistory(session, role, content) {
  if (!session || !content) {
    return;
  }
  if (!Array.isArray(session.history)) {
    session.history = [];
  }
  session.history.push({ role, content });
  session.historyLoaded = true;
}

function bumpPlaybackGeneration(session) {
  if (!session) return;
  session.playbackGeneration = (session.playbackGeneration || 0) + 1;
  session.outboundRemainder = Buffer.alloc(0);
}

function clearTwilioPlayback(session) {
  if (!session) {
    return;
  }
  bumpPlaybackGeneration(session);
  session.aiSpeaking = false;
  session.suppressStaleOutput = true;
  session.turnFirstAudioLogged = false;
  session.clearAt = nowMs();
  if (!session.twilioWs || session.twilioWs.readyState !== 1 || !session.streamSid) {
    return;
  }
  try {
    session.twilioWs.send(
      JSON.stringify({
        event: 'clear',
        streamSid: session.streamSid,
      })
    );
    logger.info(
      'LATENCY',
      `twilio_clear call=${session.callSid} t+${elapsedMs(session)}ms`
    );
  } catch (error) {
    logger.warn('LIVE', `Failed to clear Twilio playback: ${error.message}`);
  }
}

/**
 * Convert one Gemini PCM chunk once and send each Twilio frame exactly once.
 */
function playGeminiPcmOnce(session, pcmBuffer, generationAtEnqueue) {
  if (!session || !pcmBuffer || !pcmBuffer.length) {
    return;
  }
  if (session.suppressStaleOutput && generationAtEnqueue !== session.playbackGeneration) {
    return;
  }
  if (generationAtEnqueue !== session.playbackGeneration) {
    return;
  }
  if (!session.streamSid || !session.twilioWs || session.twilioWs.readyState !== 1) {
    return;
  }
  if (session.waiting) {
    return;
  }

  // Fresh model audio after interrupt: allow playback again.
  if (session.suppressStaleOutput) {
    session.suppressStaleOutput = false;
  }
  session.aiSpeaking = true;

  session.geminiChunkCount = (session.geminiChunkCount || 0) + 1;
  const chunkId = session.geminiChunkCount;

  if (!session.firstGeminiAudioAt) {
    session.firstGeminiAudioAt = nowMs();
  }
  if (!session.turnFirstAudioLogged) {
    // New AI reply turn: never reuse greeting / prior turn Twilio send stamp.
    // Do NOT clear latencyBreakdownLogged here — that allowed a later AI chunk
    // to pair with a stale geminiUserTurnCompleteAt from a previous turn.
    session.turnFirstAudioLogged = true;
    session.turnTwilioFirstSendAt = null;
    session.twilioSendTurnSeq = null;
    if (!session.latencyBreakdownLogged) {
      session.latencyBreakdownIncompleteLogged = false;
      session.turnGeminiFirstAudioAt = nowMs();
      session.firstAudioTurnSeq = session.latencyTurnSeq || null;
      logger.info(
        'LATENCY',
        `gemini_first_audio call=${session.callSid} turn=${session.latencyTurnSeq || 0} t+${elapsedMs(session)}ms chunk=${chunkId}`
      );
      if (session.lastUserTurnEndAt) {
        const gapMs = Math.max(0, nowMs() - session.lastUserTurnEndAt);
        logger.info(
          'LATENCY',
          `user_stop_to_ai_audio call=${session.callSid} gap=${gapMs}ms t+${elapsedMs(session)}ms`
        );
        session.lastUserTurnEndAt = null;
      }
    }
  }

  let mulaw;
  try {
    mulaw = pcm24kToMulaw8k(pcmBuffer);
  } catch (error) {
    logger.error('LIVE', `Audio downconvert failed: ${error.message}`);
    return;
  }

  if (generationAtEnqueue !== session.playbackGeneration) {
    return;
  }

  const { frames, remainder } = chunkMulawForTwilio(
    mulaw,
    TWILIO_FRAME_BYTES,
    session.outboundRemainder
  );
  session.outboundRemainder = remainder;

  logger.info(
    'AUDIO',
    `OUT call=${session.callSid} geminiChunk=${chunkId} pcmBytes=${pcmBuffer.length} mulawBytes=${mulaw.length} frames=${frames.length}`
  );

  for (const frame of frames) {
    if (generationAtEnqueue !== session.playbackGeneration) {
      break;
    }
    if (!frame || frame.length !== TWILIO_FRAME_BYTES) {
      continue;
    }
    session.twilioFrameCount = (session.twilioFrameCount || 0) + 1;
    if (!session.firstTwilioOutAt) {
      session.firstTwilioOutAt = nowMs();
      logger.info(
        'LATENCY',
        `twilio_first_out call=${session.callSid} t+${elapsedMs(session)}ms`
      );
    }
    try {
      session.twilioWs.send(
        JSON.stringify({
          event: 'media',
          streamSid: session.streamSid,
          media: {
            payload: frame.toString('base64'),
          },
        })
      );
      if (
        session.turnTwilioFirstSendAt == null &&
        session.turnGeminiFirstAudioAt != null &&
        !session.latencyBreakdownLogged
      ) {
        session.turnTwilioFirstSendAt = nowMs();
        session.twilioSendTurnSeq = session.latencyTurnSeq || null;
        const logged = maybeLogLatencyBreakdown(session);
        if (
          !logged &&
          !session.latencyBreakdownIncompleteLogged &&
          session.lastSpeechAudioAt != null &&
          session.geminiUserTurnCompleteAt == null
        ) {
          logBreakdownIncomplete(
            session,
            'missing_turn_complete',
            {
              userStop: session.lastSpeechAudioAt,
              turnComplete: session.geminiUserTurnCompleteAt,
              firstAudio: session.turnGeminiFirstAudioAt,
              twilioSend: session.turnTwilioFirstSendAt,
              turnSeq: session.latencyTurnSeq,
            }
          );
        }
      }
    } catch (error) {
      logger.warn('LIVE', `Twilio media send failed: ${error.message}`);
      break;
    }
  }
}

/**
 * Execute Live function calls and sendToolResponse (sync FC — model waits).
 * Does not clear Twilio audio / barge-in.
 * @param {object} session
 * @param {{ id?: string, name: string, args: object }[]} functionCalls
 */
async function handleLiveToolCalls(session, functionCalls) {
  if (!session || !session.liveSession || !Array.isArray(functionCalls)) {
    return;
  }
  if (session.ending) {
    return;
  }

  const responses = [];
  for (const call of functionCalls) {
    const name = call && call.name ? String(call.name) : '';
    const id = call && call.id != null ? String(call.id) : undefined;

    // File-sourced knowledge bootstrap removed — Agent.prompt is indexed on Save.
  // Never re-index during a live call — searchKnowledge reads ready chunks only.
  if (name === 'searchKnowledge') {
      const query =
        (call.args && (call.args.query || call.args.q)) || '';
      const result = await knowledgeService.searchKnowledge(String(query), {
        topK: env.knowledgeTopK,
        maxChars: env.knowledgeMaxChars,
        callSid: session.callSid,
      });
      const hits = (result.snippets && result.snippets.length) || 0;
      const path = result.path || 'unknown';
      const durationMs =
        result.durationMs != null ? result.durationMs : '-';
      logger.info(
        'LIVE',
        `LIVE_TOOL name=searchKnowledge model=${env.geminiLiveModel} callSid=${session.callSid} path=${path} duration_ms=${durationMs} hits=${hits}`
      );
      responses.push({
        id,
        name: 'searchKnowledge',
        response: { result },
      });
      continue;
    }

    logger.warn('LIVE', `LIVE_TOOL unsupported name=${name}`);
    responses.push({
      id,
      name: name || 'unknown',
      response: {
        result: {
          snippets: [],
          usedFallback: false,
          message: 'Unsupported tool.',
        },
      },
    });
  }

  if (!responses.length) {
    return;
  }
  // Re-check session still current before sending.
  if (!session.liveSession || session.ending) {
    return;
  }
  geminiLiveService.sendToolResponse(session.liveSession, responses);
}

function handleLiveMessage(session, message, listenerEpoch) {
  if (!session || session.ending) {
    return;
  }
  // Drop messages from a superseded Live session.
  if (listenerEpoch != null && listenerEpoch !== session.liveSessionEpoch) {
    return;
  }

  const parsed = geminiLiveService.parseLiveMessage(message);

  // Synchronous Live tool calls — answer before continuing other handling.
  // Tool calls are NOT barge-in; do not clear Twilio audio here.
  if (parsed.functionCalls && parsed.functionCalls.length > 0) {
    handleLiveToolCalls(session, parsed.functionCalls).catch((error) => {
      logger.error(
        'LIVE',
        `tool dispatch failed callSid=${session.callSid}: ${error.message}`
      );
    });
  }

  // --- Session management (long-call) ---
  if (parsed.sessionResumptionUpdate) {
    const update = parsed.sessionResumptionUpdate;
    if (update.resumable && update.newHandle) {
      session.resumptionHandle = update.newHandle;
      logger.info(
        'LIVE',
        `resumption handle stored callSid=${session.callSid} t+${elapsedMs(session)}ms`
      );
    }
  }

  if (parsed.goAway) {
    logger.warn(
      'LIVE',
      `goAway callSid=${session.callSid} timeLeft=${parsed.goAway.timeLeft || 'n/a'} — resuming Gemini`
    );
    // Proactively reconnect before the socket is aborted; Twilio stays up.
    reconnectLiveSession(session, 'goAway').catch((error) => {
      logger.error(
        'LIVE',
        `goAway reconnect failed callSid=${session.callSid}: ${error.message}`
      );
    });
    // Stop using this dying socket's remaining content — reconnect owns the call.
    return;
  }

  if (parsed.interrupted) {
    session.interruptAt = nowMs();
    logger.info(
      'LATENCY',
      `interrupt_detected call=${session.callSid} t+${elapsedMs(session)}ms`
    );
    clearTwilioPlayback(session);
    dashboardSocket.broadcast({
      type: 'CALL_INTERRUPT',
      data: { callSid: session.callSid },
    });
    logger.info('LIVE', `interrupt callSid=${session.callSid}`);
    // Do not play any audio that arrived on the same interrupted message.
    return;
  }

  // --- Caller transcript (must finalize before AI audio/text for dashboard order) ---
  // Gemini JS SDK often never sets inputTranscription.finished — do not rely on it alone.
  if (parsed.inputTranscription) {
    session.inputTranscriptBuffer =
      (session.inputTranscriptBuffer || '') + parsed.inputTranscription;
    broadcastCallerStreaming(session, session.inputTranscriptBuffer);
  }
  if (parsed.interimInputTranscription) {
    broadcastCallerStreaming(session, parsed.interimInputTranscription);
    if (
      !session.inputTranscriptBuffer ||
      parsed.interimInputTranscription.length >=
        session.inputTranscriptBuffer.length
    ) {
      session.inputTranscriptBuffer = parsed.interimInputTranscription;
    }
  }

  const modelAlreadyReplying =
    Boolean((session.outputTranscriptBuffer || '').trim()) ||
    session.turnGeminiFirstAudioAt != null ||
    session.aiSpeaking;

  const shouldFlushInput =
    parsed.inputFinished ||
    parsed.userActivityEnd ||
    Boolean(parsed.outputTranscription) ||
    parsed.turnComplete ||
    (parsed.audioBuffers && parsed.audioBuffers.length > 0) ||
    (modelAlreadyReplying &&
      Boolean(
        parsed.inputTranscription || parsed.interimInputTranscription
      ));

  if (shouldFlushInput && (session.inputTranscriptBuffer || '').trim()) {
    flushInputTranscript(session).catch((error) => {
      logger.error('LIVE', `flushInputTranscript: ${error.message}`);
    });
  }

  if (
    (parsed.inputFinished || parsed.userActivityEnd) &&
    session.geminiUserTurnCompleteAt == null
  ) {
    const t = nowMs();
    // Bind turn-complete to the active latency window (create one if needed).
    if (!session.latencyTurnSeq) {
      beginNewUserLatencyWindow(session);
    }
    session.geminiUserTurnCompleteAt = t;
    session.turnCompleteTurnSeq = session.latencyTurnSeq;
    session.lastUserTurnEndAt = t;
  }

  // --- AI audio playback ---
  const generation = session.playbackGeneration;
  for (const pcm of parsed.audioBuffers) {
    playGeminiPcmOnce(session, pcm, generation);
  }

  if (parsed.turnComplete) {
    session.aiSpeaking = false;
    session.turnFirstAudioLogged = false;
    resetOutboundReplyStamps(session);
  }

  // --- AI transcript ---
  if (parsed.outputTranscription) {
    session.outputTranscriptBuffer =
      (session.outputTranscriptBuffer || '') + parsed.outputTranscription;
    dashboardSocket.broadcast({
      type: 'AI_STREAMING',
      data: {
        callSid: session.callSid,
        content: session.outputTranscriptBuffer,
      },
    });
    if (parsed.outputFinished || parsed.turnComplete) {
      flushOutputTranscript(session).catch((error) => {
        logger.error('LIVE', `flushOutputTranscript: ${error.message}`);
      });
    }
  } else if (parsed.turnComplete) {
    flushOutputTranscript(session).catch((error) => {
      logger.error('LIVE', `flushOutputTranscript: ${error.message}`);
    });
  }
}

function broadcastCallerStreaming(session, text) {
  const content = String(text || '').trim();
  if (!session || !content) {
    return;
  }
  dashboardSocket.broadcast({
    type: 'CALLER_STREAMING',
    data: {
      callSid: session.callSid,
      content,
    },
  });
}

/** Truncate transcript for DEBUG logs (no raw audio / secrets). */
function debugTranscriptSnippet(text, maxLen = 200) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '(empty)';
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

async function flushInputTranscript(session) {
  const input = (session.inputTranscriptBuffer || '').trim();
  session.inputTranscriptBuffer = '';
  if (!input) {
    return;
  }
  session.debugTurnSeq = (session.debugTurnSeq || 0) + 1;
  // Side-channel only: Live replies from caller AUDIO, not this text.
  logger.info(
    'MULTILINGUAL_DEBUG',
    `caller_input_transcription call=${session.callSid} turn=${session.debugTurnSeq} text="${debugTranscriptSnippet(input)}" note=dashboard_stt_side_channel_not_fed_as_text_to_model`
  );
  await onCallerUtterance(session, input);
}

async function flushOutputTranscript(session) {
  const output = (session.outputTranscriptBuffer || '').trim();
  session.outputTranscriptBuffer = '';
  if (!output || session.waiting) {
    return;
  }
  logger.info(
    'MULTILINGUAL_DEBUG',
    `assistant_output_transcription call=${session.callSid} turn=${session.debugTurnSeq || '?'} text="${debugTranscriptSnippet(output)}" note=spoken_reply_side_channel`
  );
  // Transcripts are for Mongo/dashboard only — never synthesize speech from them.
  pushHistory(session, 'assistant', output);
  saveMessage(session.callSid, 'assistant', output).catch(() => {});
  dashboardSocket.broadcast({
    type: 'AI_RESPONSE',
    data: {
      callSid: session.callSid,
      content: output,
    },
  });
  callService.touchActivity(session.callSid).catch(() => {});
}

async function finalizeTranscripts(session) {
  await flushInputTranscript(session);
  await flushOutputTranscript(session);
}

async function onCallerUtterance(session, text) {
  pushHistory(session, 'user', text);
  saveMessage(session.callSid, 'user', text).catch(() => {});
  dashboardSocket.broadcast({
    type: 'CALLER_MESSAGE',
    data: {
      callSid: session.callSid,
      content: text,
    },
  });
  callService.touchActivity(session.callSid).catch(() => {});

  if (isWaitHold(text)) {
    session.waiting = true;
    session.forwardAudio = false;
    clearTwilioPlayback(session);
    try {
      if (session.liveSession) {
        session.liveSession.sendRealtimeInput({ audioStreamEnd: true });
      }
    } catch {
      // ignore
    }
    dashboardSocket.broadcast({
      type: 'AI_WAITING',
      data: {
        callSid: session.callSid,
        reason: 'caller_hold',
      },
    });
    logger.info('LIVE', `wait hold callSid=${session.callSid}`);
    return;
  }

  if (session.waiting) {
    session.waiting = false;
    session.forwardAudio = true;
    if (isResume(text)) {
      return;
    }
  }

  // Quick-facts / speakExactLine business bypass is disabled on the Live path.
}

function closeLiveSessionQuietly(liveSession) {
  if (!liveSession) {
    return;
  }
  try {
    liveSession.close();
  } catch (error) {
    logger.warn('LIVE', `live close: ${error.message}`);
  }
}

function clearReconnectTimer(session) {
  if (!session || !session.reconnectTimer) {
    return;
  }
  clearTimeout(session.reconnectTimer);
  session.reconnectTimer = null;
}

function twilioStreamAlive(session) {
  return Boolean(
    session &&
      session.twilioWs &&
      session.twilioWs.readyState === 1 &&
      !session.ending
  );
}

/**
 * Billing/quota closes will not recover by reconnecting — stop the loop.
 * @param {string} reason
 */
function isNonRetryableLiveClose(reason) {
  const raw = String(reason || '').toLowerCase();
  return (
    raw.includes('quota') ||
    raw.includes('billing') ||
    raw.includes('resource_exhausted') ||
    raw.includes('exceeded your current') ||
    raw.includes('permission_denied') ||
    raw.includes('api key')
  );
}

/**
 * Schedule a bounded backoff reconnect. Does not stack timers.
 */
function scheduleLiveReconnect(session, reason) {
  if (!session || session.ending || !twilioStreamAlive(session)) {
    return;
  }
  if (session.reconnecting || session.connecting) {
    return;
  }
  if (session.reconnectTimer) {
    return;
  }
  if ((session.reconnectAttempts || 0) >= LIVE_RECONNECT_MAX_ATTEMPTS) {
    logger.error(
      'LIVE',
      `reconnect exhausted callSid=${session.callSid} attempts=${session.reconnectAttempts} reason=${reason}`
    );
    return;
  }

  const attempt = session.reconnectAttempts || 0;
  const delay = Math.min(
    LIVE_RECONNECT_MAX_MS,
    LIVE_RECONNECT_BASE_MS * 2 ** attempt
  );
  logger.info(
    'LIVE',
    `reconnect scheduled callSid=${session.callSid} reason=${reason} attempt=${attempt + 1} delayMs=${delay}`
  );
  session.reconnectTimer = setTimeout(() => {
    session.reconnectTimer = null;
    reconnectLiveSession(session, reason).catch((error) => {
      logger.error(
        'LIVE',
        `scheduled reconnect failed callSid=${session.callSid}: ${error.message}`
      );
    });
  }, delay);
}

/**
 * Attach callbacks for one Gemini Live socket bound to listenerEpoch.
 */
function bindLiveSessionCallbacks(session, listenerEpoch) {
  const callSid = session.callSid;
  return {
    midCall: Boolean(session.greeted),
    sessionResumptionHandle: session.resumptionHandle || null,
    onmessage: (message) => {
      const current = sessions.get(callSid);
      if (current) {
        handleLiveMessage(current, message, listenerEpoch);
      }
    },
    onerror: () => {
      logger.error(
        'LIVE',
        `session error callSid=${callSid} epoch=${listenerEpoch}`
      );
    },
    onclose: (e) => {
      const current = sessions.get(callSid);
      if (!current || current.ending) {
        return;
      }
      // Superseded socket (reconnect already bumped epoch) — ignore.
      if (listenerEpoch !== current.liveSessionEpoch) {
        return;
      }
      // Reconnect path already detached this socket.
      if (current.reconnecting) {
        return;
      }
      const closeReason = (e && e.reason) || '';
      if (isNonRetryableLiveClose(closeReason)) {
        logger.error(
          'LIVE',
          `non-retryable Gemini close callSid=${callSid} epoch=${listenerEpoch}: ${closeReason.slice(0, 200)} — not reconnecting`
        );
        if (current.liveSession) {
          current.liveSession = null;
        }
        return;
      }
      logger.info(
        'LIVE',
        `session closed callSid=${callSid} epoch=${listenerEpoch} — scheduling resume`
      );
      if (current.liveSession) {
        current.liveSession = null;
      }
      scheduleLiveReconnect(current, 'onclose');
    },
  };
}

/**
 * Open a Gemini Live connection for an existing call session (start or resume).
 * Caller owns connecting/reconnecting flags. Bumps liveSessionEpoch.
 * Requires session.agentPrompt (set at call start; reused on reconnect).
 */
async function openGeminiLiveForCall(session, reason) {
  const systemInstruction = String(session.agentPrompt || '').trim();
  if (!systemInstruction) {
    throw new Error('Agent prompt missing for Live session');
  }

  session.liveSessionEpoch = (session.liveSessionEpoch || 0) + 1;
  const listenerEpoch = session.liveSessionEpoch;
  logger.info(
    'LIVE',
    `connect callSid=${session.callSid} streamSid=${session.streamSid} epoch=${listenerEpoch} reason=${reason} resume=${Boolean(session.resumptionHandle)} agent=${session.agentName || 'n/a'}`
  );

  const liveSession = await geminiLiveService.connectLiveSession({
    ...bindLiveSessionCallbacks(session, listenerEpoch),
    systemInstruction,
    midCall: Boolean(session.greeted) || reason !== 'start',
    sessionResumptionHandle: session.resumptionHandle || null,
  });
  return { liveSession, listenerEpoch };
}

/**
 * Reconnect/resume Gemini while keeping the Twilio Media Stream open.
 * At most one in-flight reconnect; never duplicates an active Live session.
 */
async function reconnectLiveSession(session, reason) {
  if (!session || session.ending) {
    return false;
  }
  if (session.reconnecting || session.connecting) {
    return false;
  }
  if (!twilioStreamAlive(session)) {
    logger.warn(
      'LIVE',
      `reconnect skipped — Twilio stream dead callSid=${session.callSid}`
    );
    return false;
  }
  if ((session.reconnectAttempts || 0) >= LIVE_RECONNECT_MAX_ATTEMPTS) {
    logger.error(
      'LIVE',
      `reconnect refused — max attempts callSid=${session.callSid}`
    );
    return false;
  }

  clearReconnectTimer(session);
  session.reconnecting = true;
  session.reconnectAttempts = (session.reconnectAttempts || 0) + 1;

  const previous = session.liveSession;
  session.liveSession = null;
  // Drop any in-flight AI audio from the dying socket.
  clearTwilioPlayback(session);
  closeLiveSessionQuietly(previous);

  try {
    const { liveSession, listenerEpoch } = await openGeminiLiveForCall(
      session,
      reason
    );

    if (session.ending || !sessions.has(session.callSid) || !twilioStreamAlive(session)) {
      closeLiveSessionQuietly(liveSession);
      return false;
    }

    // Guard: another path must not have attached a different session.
    if (session.liveSession) {
      closeLiveSessionQuietly(liveSession);
      logger.warn(
        'LIVE',
        `reconnect dropped duplicate socket callSid=${session.callSid}`
      );
      return false;
    }

    session.liveSession = liveSession;
    session.reconnectAttempts = 0;
    logger.info(
      'LIVE',
      `Gemini resumed callSid=${session.callSid} epoch=${listenerEpoch} reason=${reason} hasHandle=${Boolean(session.resumptionHandle)}`
    );
    return true;
  } catch (error) {
    logger.error(
      'LIVE',
      `reconnect error callSid=${session.callSid} reason=${reason}: ${error.message}`
    );
    scheduleLiveReconnect(session, `${reason}_retry`);
    return false;
  } finally {
    session.reconnecting = false;
  }
}

/**
 * Create / attach exactly one Live call session when Twilio Media Stream starts.
 */
async function startLiveCall({ twilioWs, callSid, streamSid, from, to }) {
  if (!callSid) {
    throw new Error('callSid required');
  }

  let session = sessions.get(callSid);
  if (!session) {
    session = createEmptySession(callSid, twilioWs, streamSid, from, to);
    sessions.set(callSid, session);
  } else {
    session.twilioWs = twilioWs;
    session.streamSid = streamSid || session.streamSid;
    if (from) session.from = from;
    if (to) session.to = to;
  }

  // Idempotent: never attach two Gemini Live sessions to one call.
  if (session.connecting || session.reconnecting) {
    logger.warn('LIVE', `start ignored — already connecting callSid=${callSid}`);
    return session;
  }
  if (session.liveSession) {
    logger.warn(
      'LIVE',
      `start ignored — Live session already active callSid=${callSid} epoch=${session.liveSessionEpoch}`
    );
    return session;
  }

  session.connecting = true;
  clearReconnectTimer(session);

  try {
    // Fail closed: load singleton agent (or Call.agentId) before Gemini.
    if (!session.agentPrompt) {
      const call = await callService.getCallBySid(callSid);
      let resolved;
      if (call && call.agentId) {
        const agent = await agentService.getAgentById(call.agentId);
        if (
          !agent ||
          agent.status !== 'active' ||
          !agent.prompts ||
          agent.prompts.length === 0
        ) {
          throw new Error('Call agent is missing, disabled, or has no prompts');
        }
        const systemInstruction = agentService.assertLivePromptSize(agent);
        if (!systemInstruction) {
          throw new Error('Call agent has no configured prompts');
        }
        resolved = {
          agentId: agent._id,
          agentName: agent.name,
          systemInstruction,
        };
      } else {
        resolved = await agentService.requireAgentForCall();
        if (call && !call.agentId) {
          call.agentId = resolved.agentId;
          await call.save().catch(() => {});
        }
      }
      session.agentId = resolved.agentId;
      session.agentName = resolved.agentName;
      session.agentPrompt = resolved.systemInstruction;
      logger.info(
        'LIVE',
        `agent loaded callSid=${callSid} agent=${session.agentName} promptChars=${session.agentPrompt.length}`
      );
    }

    await callService.markAnswered(callSid, streamSid);
    await callService.markInProgress(callSid);

    dashboardSocket.broadcast({
      type: 'CALL_CONNECTED',
      data: {
        callSid,
        from: session.from,
        to: session.to,
        status: 'connected',
        sessionId: streamSid || null,
      },
    });

    const { liveSession, listenerEpoch } = await openGeminiLiveForCall(
      session,
      'start'
    );

    // Race: call may have ended while connecting.
    if (session.ending || !sessions.has(callSid)) {
      closeLiveSessionQuietly(liveSession);
      return session;
    }

    if (session.liveSession) {
      // Should not happen given guards; close the extra socket.
      closeLiveSessionQuietly(liveSession);
      return session;
    }

    session.liveSession = liveSession;
    session.reconnectAttempts = 0;

    if (!session.greeted) {
      session.greeted = true;
      geminiLiveService.requestGreeting(
        liveSession,
        buildGreetingInstruction()
      );
      logger.info('LIVE', `greeting requested once callSid=${callSid}`);
    }

    logger.info(
      'LIVE',
      `Live call ready callSid=${callSid} streamSid=${streamSid} epoch=${listenerEpoch}`
    );
    return session;
  } finally {
    session.connecting = false;
  }
}

function forwardTwilioMedia(session, payloadBase64) {
  if (!session || !session.liveSession || !session.forwardAudio || session.waiting) {
    return;
  }
  if (!payloadBase64) {
    return;
  }
  try {
    session.inboundMediaCount = (session.inboundMediaCount || 0) + 1;
    session.lastCallerAudioAt = nowMs();
    const mulaw = Buffer.from(payloadBase64, 'base64');
    const pcm16k = mulaw8kToPcm16k(mulaw);

    if (!session.speechGate) {
      session.speechGate = createSpeechGateState();
    }
    // Gate labels speech for metrics only — always stream PCM (incl. silence)
    // so Gemini Live VAD can complete user turns.
    const speechLike = shouldForward(pcm16k, session.speechGate);
    if (!speechLike) {
      session.gatedDropCount = (session.gatedDropCount || 0) + 1;
    } else {
      session.speechLabeledCount = (session.speechLabeledCount || 0) + 1;
      const t = nowMs();
      stampCallerSpeechForLatency(session, t);
    }

    session.lastGeminiInAt = nowMs();
    session.geminiInCount = (session.geminiInCount || 0) + 1;
    geminiLiveService.sendPcm16kAudio(session.liveSession, pcm16k);

    // One-shot warn if almost nothing looks like speech after AI started talking.
    if (
      !session.gateWarnLogged &&
      session.geminiChunkCount > 0 &&
      session.inboundMediaCount >= 100 &&
      session.speechLabeledCount === 0
    ) {
      session.gateWarnLogged = true;
      logger.warn(
        'LIVE',
        `speech gate labeled 0 speech frames after AI audio callSid=${session.callSid} inbound=${session.inboundMediaCount}`
      );
    }
  } catch (error) {
    logger.error('LIVE', `forward media failed: ${error.message}`);
  }
}

async function endLiveCall(callSid, reason = 'stop') {
  const session = sessions.get(callSid);
  if (!session || session.ending) {
    return;
  }
  session.ending = true;
  session.forwardAudio = false;
  clearReconnectTimer(session);
  bumpPlaybackGeneration(session);

  const live = session.liveSession;
  session.liveSession = null;
  closeLiveSessionQuietly(live);

  try {
    await finalizeTranscripts(session);
  } catch {
    // ignore
  }

  const gate = session.speechGate || {};
  logger.info(
    'LIVE',
    `stats callSid=${callSid} geminiChunks=${session.geminiChunkCount || 0} twilioFrames=${session.twilioFrameCount || 0} inbound=${session.inboundMediaCount || 0} geminiIn=${session.geminiInCount || 0} speechLabeled=${session.speechLabeledCount || 0} nonSpeechLabeled=${session.gatedDropCount || 0} gateFwd=${gate.forwardedFrames || 0}`
  );

  sessions.delete(callSid);

  const call = await callService.markCompleted(callSid);
  dashboardSocket.broadcast({
    type: 'CALL_COMPLETED',
    data: {
      callSid,
      status: 'completed',
      duration: call && call.duration != null ? call.duration : null,
      reason,
    },
  });
  logger.info('LIVE', `call ended callSid=${callSid} reason=${reason}`);
}

function closeAllSessions() {
  for (const callSid of [...sessions.keys()]) {
    endLiveCall(callSid, 'shutdown').catch(() => {});
  }
}

module.exports = {
  sessions,
  getSession,
  getSessionByWs,
  startLiveCall,
  forwardTwilioMedia,
  endLiveCall,
  clearTwilioPlayback,
  closeAllSessions,
  saveMessage,
  playGeminiPcmOnce,
  handleLiveMessage,
  handleLiveToolCalls,
  maybeLogLatencyBreakdown,
  setNowMsForTests,
  resetOutboundReplyStamps,
  beginNewUserLatencyWindow,
  clearLatencyLogOnStartup,
  stampCallerSpeechForLatency,
  reconnectLiveSession,
  scheduleLiveReconnect,
  LIVE_RECONNECT_MAX_ATTEMPTS,
  LATENCY_LOG_PATH,
  parseLiveMessageForTests: geminiLiveService.parseLiveMessage,
};
