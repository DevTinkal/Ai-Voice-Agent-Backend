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
const {
  isWaitHold,
  isResume,
  isHoldNoiseFragment,
  isIncompleteWaitPrefix,
  normalize: normalizeWaitText,
} = require('../utils/waitIntent');
const {
  mulaw8kToPcm16k,
  pcm24kToMulaw8k,
  chunkMulawForTwilio,
  TWILIO_FRAME_BYTES,
} = require('../utils/audioCodec');
const {
  createSpeechGateState,
  evaluateFrame,
  isBargeInConfirmed,
} = require('../utils/speechGate');
const {
  createPcmBatchState,
  pushPcmBatch,
  flushPcmBatch,
  summarizePcmBatch,
} = require('../utils/pcmBatcher');
const { buildGreetingInstruction } = require('../config/prompts');
const logger = require('../utils/logger');

/** @type {Map<string, object>} */
const sessions = new Map();

/**
 * Shared first-response timeline across /voice/outbound → Media Stream start.
 * Instrumentation only — does not affect call behavior.
 * @type {Map<string, { t0: number, lastAt: number }>}
 */
const firstResponseByCall = new Map();

const LATENCY_LOG_PATH = path.join(__dirname, '../../logs/latency-latest.log');
/** Rate-limit AUDIO_GATE logs per call (ms). */
const AUDIO_GATE_LOG_COOLDOWN_MS = 800;

/**
 * True when transcript is too tiny/garbage to treat as a caller utterance.
 * Keeps real short commands like "Wait!" / "Ok".
 * @param {string} text
 */
function isNoiseTranscript(text) {
  const raw = String(text || '').trim();
  if (!raw) {
    return true;
  }
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, '');
  if (alnum.length < 2) {
    return true;
  }
  // Pure punctuation / filler noise from STT on background audio.
  if (/^[\s.!?…,;:\-_"'`~]+$/.test(raw)) {
    return true;
  }
  // Tiny hold-noise fragments (de/yo/uh) must not become CALLER_MESSAGE
  // and must not resume WAIT.
  if (isHoldNoiseFragment(raw)) {
    return true;
  }
  return false;
}

/**
 * Rate-limited AUDIO_GATE log lines.
 * @param {object} session
 * @param {string} message
 */
function logAudioGate(session, message) {
  if (!session) {
    return;
  }
  const now = nowMs();
  const last = session.audioGateLogAt || 0;
  const lastMsg = session.audioGateLogMsg || '';
  if (message === lastMsg && now - last < AUDIO_GATE_LOG_COOLDOWN_MS) {
    return;
  }
  session.audioGateLogAt = now;
  session.audioGateLogMsg = message;
  logger.info('AUDIO_GATE', `${message} callSid=${session.callSid}`);
}

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
 * Temporary first-response latency instrumentation only — no behavior change.
 * Timeline origin is preferably outbound answer (/voice/outbound); otherwise
 * Media Stream start. Shared across HTTP webhook → WebSocket via callSid map.
 * @param {string} callSid
 * @param {string} step
 * @returns {number} timeline t0
 */
function stampFirstResponse(callSid, step) {
  const key = String(callSid || '').trim() || '-';
  const now = nowMs();
  let state = firstResponseByCall.get(key);
  if (!state) {
    state = { t0: now, lastAt: now };
    firstResponseByCall.set(key, state);
    logger.info(
      'FIRST_RESPONSE',
      `[FIRST_RESPONSE] ${step} callSid=${key} total_ms=0 delta_ms=0`
    );
    return state.t0;
  }
  const totalMs = Math.max(0, now - state.t0);
  const deltaMs = Math.max(0, now - state.lastAt);
  state.lastAt = now;
  logger.info(
    'FIRST_RESPONSE',
    `[FIRST_RESPONSE] ${step} callSid=${key} total_ms=${totalMs} delta_ms=${deltaMs}`
  );
  return state.t0;
}

/**
 * Start first-response clock at outbound answer (before Media Stream).
 * @param {string} callSid
 * @returns {number|null} t0
 */
function beginFirstResponseTimeline(callSid) {
  const key = String(callSid || '').trim();
  if (!key) {
    return null;
  }
  const t0 = nowMs();
  firstResponseByCall.set(key, { t0, lastAt: t0 });
  logger.info(
    'FIRST_RESPONSE',
    `[FIRST_RESPONSE] outbound_call_answered callSid=${key} total_ms=0 delta_ms=0`
  );
  return t0;
}

/**
 * @param {string} callSid
 * @returns {number|null}
 */
function getFirstResponseOrigin(callSid) {
  const state = firstResponseByCall.get(String(callSid || '').trim());
  return state ? state.t0 : null;
}

function clearFirstResponseTimeline(callSid) {
  if (callSid) {
    firstResponseByCall.delete(String(callSid));
  }
}

/**
 * @param {object|null} session
 * @param {string} step
 * @param {string} [callSidOverride]
 */
function logFirstResponse(session, step, callSidOverride) {
  const callSid =
    (session && session.callSid) || callSidOverride || '-';
  const t0 = stampFirstResponse(callSid, step);
  if (session) {
    session.t0 = t0;
    const state = firstResponseByCall.get(String(callSid));
    if (state) {
      session.firstResponseLastAt = state.lastAt;
    }
  }
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
    /** WAIT state machine: NORMAL | WAITING */
    waitPhase: 'NORMAL',
    waitEnteredAt: null,
    waitPhrase: null,
    waitStreamEndSent: false,
    forwardAudio: true,
    inputTranscriptBuffer: '',
    outputTranscriptBuffer: '',
    outboundRemainder: Buffer.alloc(0),
    playbackGeneration: 0,
    geminiChunkCount: 0,
    twilioFrameCount: 0,
    inboundMediaCount: 0,
    inboundMulawBytes: 0,
    gatedDropCount: 0,
    speechLabeledCount: 0,
    silenceReplacedCount: 0,
    geminiInCount: 0,
    geminiPcmBytes: 0,
    audioForwardSkipped: 0,
    /** Optional PCM batching toward Gemini (default 0 = immediate). */
    pcmBatch: createPcmBatchState(env.geminiPcmBatchMs),
    /**
     * Gemini PCM queued before Twilio Media Stream is attached (outbound prime).
     * @type {Array<{ pcm: Buffer, generation: number }>}
     */
    pendingOutboundPcm: [],
    /** In-flight outbound Gemini prime promise (answer → Media Stream overlap). */
    primePromise: null,
    gateWarnLogged: false,
    audioGateLogAt: 0,
    audioGateLogMsg: '',
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
    lastTwilioClearAt: null,
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
    /** Last [FIRST_RESPONSE] stamp time for delta_ms (instrumentation only). */
    firstResponseLastAt: null,
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
  session.lastTwilioClearAt = session.clearAt;
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
    logger.info(
      'LIVE',
      `[TWILIO_CLEAR] callSid=${session.callSid} streamSid=${session.streamSid}`
    );
  } catch (error) {
    logger.warn('LIVE', `Failed to clear Twilio playback: ${error.message}`);
  }
}

/**
 * Gemini interrupted: clear Twilio only when barge-in is speechGate-confirmed
 * and clear debounce allows. Brief noise while AI speaks must not clear playback.
 * Never mutes caller PCM / never sets waiting from noise.
 */
function handleGeminiInterrupted(session) {
  if (!session) {
    return;
  }
  const t = nowMs();
  session.interruptAt = t;
  logger.info(
    'LATENCY',
    `interrupt_detected call=${session.callSid} t+${elapsedMs(session)}ms`
  );
  logger.info('LIVE', `[GEMINI_INTERRUPT] callSid=${session.callSid}`);

  const gate = session.speechGate;
  const confirmWindow =
    Number(env.bargeInConfirmWindowMs) || 480;
  const debounceMs = Number(env.bargeInClearDebounceMs) || 500;
  const lastClear = Number(session.lastTwilioClearAt) || 0;
  const withinDebounce = lastClear > 0 && t - lastClear < debounceMs;

  const confirmed = isBargeInConfirmed(gate, {
    nowMs: t,
    confirmWindowMs: confirmWindow,
  });
  const aiWasSpeaking = Boolean(session.aiSpeaking);
  const gateOpen = Boolean(gate && gate.open);
  // Confirm-only: do not clear on aiSpeaking+gateOpen alone (noise spikes).
  const shouldClear = !withinDebounce && confirmed;

  if (shouldClear) {
    logger.info(
      'LIVE',
      `[BARGE_IN_CONFIRMED] callSid=${session.callSid} confirmed=${confirmed} aiSpeaking=${aiWasSpeaking} gateOpen=${gateOpen}`
    );
    clearTwilioPlayback(session);
    dashboardSocket.broadcast({
      type: 'CALL_INTERRUPT',
      data: { callSid: session.callSid },
    });
  } else {
    logger.info(
      'LIVE',
      `[BARGE_IN_REJECTED] callSid=${session.callSid} reason=${
        withinDebounce ? 'clear_debounce' : 'unconfirmed_noise'
      } confirmed=${confirmed} aiSpeaking=${aiWasSpeaking} gateOpen=${gateOpen}`
    );
    // Drop stale Gemini chunks from the aborted turn so noise interrupts
    // do not scramble the next playback (debounce and unconfirmed noise).
    bumpPlaybackGeneration(session);
    session.suppressStaleOutput = true;
    session.aiSpeaking = false;
    session.turnFirstAudioLogged = false;
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
  if (session.waiting || session.waitPhase === 'WAITING') {
    return;
  }

  const twilioReady =
    Boolean(session.streamSid) &&
    Boolean(session.twilioWs) &&
    session.twilioWs.readyState === 1;

  // Outbound prime: Media Stream not attached yet — queue PCM for flush.
  if (!twilioReady) {
    if (!Array.isArray(session.pendingOutboundPcm)) {
      session.pendingOutboundPcm = [];
    }
    session.pendingOutboundPcm.push({
      pcm: Buffer.from(pcmBuffer),
      generation: generationAtEnqueue,
    });
    if (!session.firstGeminiAudioAt) {
      session.firstGeminiAudioAt = nowMs();
      logFirstResponse(session, 'first_gemini_audio');
    }
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
    logFirstResponse(session, 'first_gemini_audio');
  }
  if (!session.turnFirstAudioLogged) {
    // New AI reply turn: never reuse greeting / prior turn Twilio send stamp.
    // Do NOT clear latencyBreakdownLogged here — that allowed a later AI chunk
    // to pair with a stale geminiUserTurnCompleteAt from a previous turn.
    session.turnFirstAudioLogged = true;
    session.turnTwilioFirstSendAt = null;
    session.twilioSendTurnSeq = null;
    logger.info(
      'LIVE',
      `[AI_RESPONSE_START][AI_AUDIO_OUT] callSid=${session.callSid} gen=${session.playbackGeneration} chunk=${chunkId}`
    );
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
      logFirstResponse(session, 'first_twilio_audio');
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
      const q = String(query).replace(/\s+/g, ' ').trim();
      logger.info(
        'LIVE',
        `[VOICE_TURN] callSid=${session.callSid} tool=searchKnowledge query="${String(q).slice(0, 120).replace(/"/g, "'")}"`
      );
      const result = await knowledgeService.searchKnowledge(q, {
        topK: env.knowledgeTopK,
        maxChars: env.knowledgeMaxChars,
        callSid: session.callSid,
      });
      const snippets = Array.isArray(result.snippets) ? result.snippets : [];
      const hits = snippets.length;
      const found = Boolean(result.found) && hits > 0;
      const path = result.path || 'unknown';
      const durationMs =
        result.durationMs != null ? result.durationMs : '-';
      const scores = snippets.map((s) => s.score).join(',');
      const preview = String((snippets[0] && snippets[0].text) || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
        .replace(/"/g, "'");
      logger.info(
        'LIVE',
        `[LIVE_TOOL] name=searchKnowledge model=${env.geminiLiveModel} callSid=${session.callSid} path=${path} duration_ms=${durationMs} hits=${hits} found=${found}`
      );
      logger.info(
        'LIVE',
        `[KNOWLEDGE_RESULT] callSid=${session.callSid} path=${path} hits=${hits} scores=[${scores}] preview="${preview}"`
      );
      const toolPayload = {
        found,
        snippets: snippets.map((s) => ({
          text: String(s.text || ''),
          score: s.score,
        })),
        message: found
          ? undefined
          : result.message || 'No relevant knowledge was found.',
      };
      if (!toolPayload.message) {
        delete toolPayload.message;
      }
      responses.push({
        id,
        name: 'searchKnowledge',
        response: toolPayload,
      });
      continue;
    }

    logger.warn('LIVE', `LIVE_TOOL unsupported name=${name}`);
    responses.push({
      id,
      name: name || 'unknown',
      response: {
        found: false,
        snippets: [],
        message: 'Unsupported tool.',
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

  // Process caller transcripts BEFORE interrupt early-out so WAIT text on the
  // same message is never dropped.
  applyCallerTranscriptUpdate(session, parsed);
  maybeEnterWaitFromStreaming(session);

  if (parsed.interrupted) {
    logWaitTrace(session, {
      stage: 'INTERRUPT',
      text: session.inputTranscriptBuffer || '',
      action: isSessionWaiting(session) ? 'KEEP_WAITING_AFTER_INTERRUPT' : 'BARGE_IN_ONLY',
    });
    handleGeminiInterrupted(session);
    // Do not play any audio that arrived on the same interrupted message.
    // Still allow flush of a completed WAIT utterance below if appropriate.
  }

  const modelAlreadyReplying =
    Boolean((session.outputTranscriptBuffer || '').trim()) ||
    session.turnGeminiFirstAudioAt != null ||
    session.aiSpeaking;

  const bufNow = String(session.inputTranscriptBuffer || '').trim();
  const deferFlushForWaitPrefix =
    Boolean(bufNow) &&
    isIncompleteWaitPrefix(bufNow) &&
    !parsed.inputFinished &&
    !parsed.userActivityEnd;

  const shouldFlushInput =
    !deferFlushForWaitPrefix &&
    (parsed.inputFinished ||
      parsed.userActivityEnd ||
      Boolean(parsed.outputTranscription) ||
      parsed.turnComplete ||
      // AI audio may arrive before outputTranscription — flush caller text then,
      // but never while the buffer is still an incomplete WAIT prefix ("wa").
      (Boolean(parsed.audioBuffers && parsed.audioBuffers.length > 0) &&
        !isIncompleteWaitPrefix(bufNow)) ||
      (modelAlreadyReplying &&
        Boolean(
          parsed.inputTranscription || parsed.interimInputTranscription
        ) &&
        !isIncompleteWaitPrefix(bufNow)));

  if (deferFlushForWaitPrefix) {
    logWaitTrace(session, {
      stage: 'STREAMING',
      text: bufNow,
      detected: false,
      action: 'DEFER_FLUSH_PREFIX',
    });
  }

  if (shouldFlushInput && bufNow) {
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

  // --- AI audio playback (skipped entirely on interrupted messages) ---
  if (!parsed.interrupted) {
    const generation = session.playbackGeneration;
    for (const pcm of parsed.audioBuffers) {
      playGeminiPcmOnce(session, pcm, generation);
    }
  }

  if (parsed.turnComplete) {
    session.aiSpeaking = false;
    session.turnFirstAudioLogged = false;
    resetOutboundReplyStamps(session);
  }

  // --- AI transcript ---
  // While WAIT is active, do not stream/finalize AI text (keeps UI on Waiting).
  if (isSessionWaiting(session)) {
    if (parsed.outputTranscription || (parsed.audioBuffers && parsed.audioBuffers.length)) {
      logWaitTrace(session, {
        stage: 'SUPPRESS_AI',
        text: '',
        action: 'DROP_OUTPUT_WHILE_WAITING',
      });
    }
    session.outputTranscriptBuffer = '';
  } else if (parsed.outputTranscription) {
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

function isSessionWaiting(session) {
  return Boolean(
    session && (session.waiting || session.waitPhase === 'WAITING')
  );
}

/**
 * Structured WAIT diagnostics for real-call investigation (text only).
 * @param {object} session
 * @param {object} fields
 */
function logWaitTrace(session, fields = {}) {
  if (!session) {
    return;
  }
  const text = debugTranscriptSnippet(fields.text != null ? fields.text : '', 80);
  const normalized = normalizeWaitText(fields.text != null ? fields.text : '');
  const detected =
    fields.detected != null
      ? Boolean(fields.detected)
      : normalized
        ? isWaitHold(normalized)
        : false;
  const waitingBefore =
    fields.waiting_before != null
      ? Boolean(fields.waiting_before)
      : isSessionWaiting(session);
  logger.info(
    'LIVE',
    `[WAIT_TRACE] callSid=${session.callSid || '?'} stage=${fields.stage || '?'}` +
      ` text="${String(text).replace(/"/g, "'")}"` +
      ` normalized="${String(normalized || '').slice(0, 80).replace(/"/g, "'")}"` +
      ` detected=${detected}` +
      ` waiting_before=${waitingBefore}` +
      ` waiting_after=${
        fields.waiting_after != null
          ? Boolean(fields.waiting_after)
          : isSessionWaiting(session)
      }` +
      ` waitPhase=${session.waitPhase || 'NORMAL'}` +
      ` aiSpeaking=${Boolean(session.aiSpeaking)}` +
      ` playbackCleared=${Boolean(fields.playbackCleared)}` +
      ` action=${fields.action || '?'}`
  );
}

/**
 * Apply Gemini input/interim transcription into the session buffer.
 * @param {object} session
 * @param {object} parsed
 */
function applyCallerTranscriptUpdate(session, parsed) {
  if (!session || !parsed) {
    return;
  }
  // Gemini JS SDK often never sets inputTranscription.finished — do not rely on it alone.
  if (parsed.inputTranscription) {
    session.inputTranscriptBuffer =
      (session.inputTranscriptBuffer || '') + parsed.inputTranscription;
    broadcastCallerStreaming(session, session.inputTranscriptBuffer);
    logWaitTrace(session, {
      stage: 'STREAMING',
      text: session.inputTranscriptBuffer,
      action: 'INPUT_APPEND',
    });
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
    logWaitTrace(session, {
      stage: 'STREAMING',
      text: session.inputTranscriptBuffer,
      action: 'INTERIM_SET',
    });
  }
}

async function flushInputTranscript(session) {
  const input = (session.inputTranscriptBuffer || '').trim();
  session.inputTranscriptBuffer = '';
  if (!input) {
    return;
  }
  if (isNoiseTranscript(input)) {
    logAudioGate(
      session,
      `background/noise rejected reason=noise_transcript text="${debugTranscriptSnippet(input, 40)}"`
    );
    logWaitTrace(session, {
      stage: 'NOISE',
      text: input,
      detected: false,
      action: isSessionWaiting(session) ? 'KEEP_WAITING' : 'DROP_NOISE',
    });
    return;
  }
  session.debugTurnSeq = (session.debugTurnSeq || 0) + 1;
  logger.info(
    'LIVE',
    `[VOICE_TURN] callSid=${session.callSid} turn=${session.debugTurnSeq} caller="${debugTranscriptSnippet(input)}"`
  );
  logger.info(
    'MULTILINGUAL_DEBUG',
    `caller_input_transcription call=${session.callSid} turn=${session.debugTurnSeq} text="${debugTranscriptSnippet(input)}" note=dashboard_stt_side_channel_not_fed_as_text_to_model`
  );
  logWaitTrace(session, {
    stage: 'FINAL',
    text: input,
    detected: isWaitHold(input),
    action: 'FLUSH_TO_UTTERANCE',
  });
  await onCallerUtterance(session, input);
}

async function flushOutputTranscript(session) {
  const output = (session.outputTranscriptBuffer || '').trim();
  session.outputTranscriptBuffer = '';
  if (!output || isSessionWaiting(session)) {
    return;
  }
  logger.info(
    'LIVE',
    `[AI_RESPONSE] callSid=${session.callSid} turn=${session.debugTurnSeq || '?'} text="${debugTranscriptSnippet(output)}"`
  );
  logger.info(
    'MULTILINGUAL_DEBUG',
    `assistant_output_transcription call=${session.callSid} turn=${session.debugTurnSeq || '?'} text="${debugTranscriptSnippet(output)}" note=spoken_reply_side_channel`
  );
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

/**
 * Enter or refresh WAIT hold (playback pause only — PCM still forwards).
 * Idempotent: duplicate enters only re-clear playback; one audioStreamEnd per entry.
 * @param {object} session
 * @param {string} text
 * @param {'enter'|'repeat'|'early'} action
 */
function enterWaitHold(session, text, action = 'enter') {
  if (!session) {
    return;
  }
  const waitingBefore = isSessionWaiting(session);
  const phrase = normalizeWaitText(text) || String(text || '').trim();

  session.waiting = true;
  session.waitPhase = 'WAITING';
  session.forwardAudio = true;
  session.waitPhrase = phrase || session.waitPhrase;
  if (!waitingBefore) {
    session.waitEnteredAt = nowMs();
    session.waitStreamEndSent = false;
  }
  // Drop any in-flight AI text so it cannot clear the Waiting UI later.
  session.outputTranscriptBuffer = '';

  clearTwilioPlayback(session);
  logWaitTrace(session, {
    stage: 'CLEAR_PLAYBACK',
    text: phrase,
    waiting_before: waitingBefore,
    waiting_after: true,
    playbackCleared: true,
    action: 'TWILIO_CLEAR',
  });

  try {
    // First enter/early only: end user audio stream once per WAIT entry.
    if (
      session.liveSession &&
      !session.waitStreamEndSent &&
      action !== 'repeat'
    ) {
      flushCallerPcmBatch(session, 'wait_stream_end');
      session.liveSession.sendRealtimeInput({ audioStreamEnd: true });
      session.waitStreamEndSent = true;
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

  const label = waitingBefore
    ? 'REPEAT'
    : action === 'early'
      ? 'ENTER_WAIT_EARLY'
      : 'ENTER_WAIT';
  logWaitTrace(session, {
    stage: waitingBefore ? 'REPEAT' : 'ENTER',
    text: phrase,
    detected: true,
    waiting_before: waitingBefore,
    waiting_after: true,
    playbackCleared: true,
    action: label,
  });
  logger.info(
    'LIVE',
    `[WAIT_HOLD] callSid=${session.callSid} action=${label.toLowerCase()} text="${String(
      phrase
    )
      .slice(0, 80)
      .replace(/"/g, "'")}" forwardAudio=true waiting=true waitPhase=WAITING`
  );
}

/**
 * Enter WAIT as soon as streaming/interim transcript matches a hold phrase.
 * Leaves the buffer intact so flush still emits CALLER_MESSAGE.
 * @param {object} session
 */
function maybeEnterWaitFromStreaming(session) {
  if (!session) {
    return;
  }
  const buf = String(session.inputTranscriptBuffer || '').trim();
  const normalized = normalizeWaitText(buf);
  if (!buf) {
    return;
  }
  const detected = isWaitHold(buf);
  if (!detected) {
    if (isIncompleteWaitPrefix(buf)) {
      logWaitTrace(session, {
        stage: 'STREAMING',
        text: buf,
        detected: false,
        action: 'PREFIX_PENDING',
      });
    }
    return;
  }
  if (isSessionWaiting(session)) {
    logWaitTrace(session, {
      stage: 'STREAMING',
      text: buf,
      detected: true,
      action: 'ALREADY_WAITING',
    });
    return;
  }
  logWaitTrace(session, {
    stage: 'STREAMING',
    text: buf,
    detected: true,
    normalized,
    action: 'EARLY_DETECT',
  });
  enterWaitHold(session, buf, 'early');
}

function clearWaitState(session) {
  if (!session) {
    return;
  }
  session.waiting = false;
  session.waitPhase = 'NORMAL';
  session.waitEnteredAt = null;
  session.waitPhrase = null;
  session.waitStreamEndSent = false;
}

async function onCallerUtterance(session, text) {
  // Tiny noise/fragments: never CALLER_MESSAGE and never clear WAIT.
  if (isNoiseTranscript(text)) {
    if (session && isSessionWaiting(session)) {
      logWaitTrace(session, {
        stage: 'NOISE',
        text,
        detected: false,
        action: 'KEEP_WAITING',
      });
      logger.info(
        'LIVE',
        `[WAIT_HOLD] callSid=${session.callSid} action=ignore_noise text="${String(
          text
        )
          .slice(0, 40)
          .replace(/"/g, "'")}" waiting=true`
      );
    }
    return;
  }

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
    const alreadyWaiting = isSessionWaiting(session);
    enterWaitHold(session, text, alreadyWaiting ? 'repeat' : 'enter');
    return;
  }

  if (isSessionWaiting(session)) {
    clearWaitState(session);
    session.forwardAudio = true;
    logWaitTrace(session, {
      stage: 'RESUME',
      text,
      detected: false,
      waiting_before: true,
      waiting_after: false,
      action: 'RESUME_MEANINGFUL',
    });
    logger.info(
      'LIVE',
      `[WAIT_HOLD] callSid=${session.callSid} action=resume text="${String(text)
        .slice(0, 80)
        .replace(/"/g, "'")}" waiting=false waitPhase=NORMAL`
    );
    logger.info(
      'LIVE',
      `[AI_RESPONSE_RECOVERY] callSid=${session.callSid} reason=caller_utterance`
    );
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
    midCall:
      Boolean(session.greeted) ||
      (reason !== 'start' && reason !== 'prime'),
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

  // Flush pending caller PCM to the dying socket before close (no discard).
  flushCallerPcmBatch(session, 'reconnect');

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
 * Flush Gemini PCM buffered during outbound prime once Twilio Media Stream is up.
 * @param {object} session
 */
function flushPendingOutboundPcm(session) {
  if (!session || !Array.isArray(session.pendingOutboundPcm)) {
    return;
  }
  const queued = session.pendingOutboundPcm;
  session.pendingOutboundPcm = [];
  if (!queued.length) {
    return;
  }
  logger.info(
    'LIVE',
    `[GREETING_FLUSH] callSid=${session.callSid} chunks=${queued.length}`
  );
  for (const item of queued) {
    if (!item || !item.pcm) {
      continue;
    }
    // Use current playback generation if the buffered gen was bumped away.
    const gen =
      item.generation === session.playbackGeneration
        ? item.generation
        : session.playbackGeneration;
    playGeminiPcmOnce(session, item.pcm, gen);
  }
}

/**
 * Load agent prompt onto session (fail closed).
 * @param {object} session
 * @param {string} [preferredAgentId]
 */
async function loadAgentOntoSession(session, preferredAgentId) {
  if (session.agentPrompt) {
    return;
  }
  const callSid = session.callSid;
  const call = await callService.getCallBySid(callSid);
  let resolved;
  if (preferredAgentId || (call && call.agentId)) {
    const id = preferredAgentId || call.agentId;
    const agent = await agentService.getAgentById(id);
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

/**
 * Start Gemini + greeting as soon as outbound callee answers (before Media Stream).
 * Overlaps greeting TTS with Twilio stream setup.
 * @param {string} callSid
 * @param {{ from?: string, to?: string, agentId?: * }} [opts]
 */
async function primeOutboundLive(callSid, opts = {}) {
  if (!callSid) {
    return null;
  }

  let session = sessions.get(callSid);
  if (!session) {
    session = createEmptySession(
      callSid,
      null,
      null,
      opts.from || null,
      opts.to || null
    );
    sessions.set(callSid, session);
  } else {
    if (opts.from) session.from = opts.from;
    if (opts.to) session.to = opts.to;
  }

  if (session.liveSession || session.greeted) {
    return session;
  }
  if (session.primePromise) {
    return session.primePromise;
  }
  if (session.connecting || session.reconnecting) {
    return session;
  }

  session.connecting = true;
  logFirstResponse(session, 'prime_started');

  session.primePromise = (async () => {
    try {
      await loadAgentOntoSession(session, opts.agentId);
      logFirstResponse(session, 'agent_loading_completed');

      // DB status marks must not delay greeting.
      callService.markAnswered(callSid, null).catch(() => {});
      callService.markInProgress(callSid).catch(() => {});
      dashboardSocket.broadcast({
        type: 'CALL_CONNECTED',
        data: {
          callSid,
          from: session.from,
          to: session.to,
          status: 'connected',
          sessionId: null,
        },
      });

      logFirstResponse(session, 'prime_gemini_connect_started');
      const { liveSession, listenerEpoch } = await openGeminiLiveForCall(
        session,
        'prime'
      );

      if (session.ending || !sessions.has(callSid)) {
        closeLiveSessionQuietly(liveSession);
        return session;
      }
      if (session.liveSession) {
        closeLiveSessionQuietly(liveSession);
        return session;
      }

      session.liveSession = liveSession;
      session.reconnectAttempts = 0;
      logFirstResponse(session, 'prime_gemini_connected');

      if (!session.greeted) {
        session.greeted = true;
        geminiLiveService.requestGreeting(
          liveSession,
          buildGreetingInstruction()
        );
        logFirstResponse(session, 'prime_greeting_requested');
        logger.info(
          'LIVE',
          `greeting primed once callSid=${callSid} epoch=${listenerEpoch}`
        );
      }
      return session;
    } catch (error) {
      logger.error(
        'LIVE',
        `primeOutboundLive failed callSid=${callSid}: ${error.message}`
      );
      throw error;
    } finally {
      session.connecting = false;
    }
  })();

  return session.primePromise;
}

/**
 * Create / attach exactly one Live call session when Twilio Media Stream starts.
 */
async function startLiveCall({
  twilioWs,
  callSid,
  streamSid,
  from,
  to,
  firstResponseT0,
}) {
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

  // Align first-response clock with outbound answer or Media Stream start.
  if (
    firstResponseT0 != null &&
    Number.isFinite(Number(firstResponseT0))
  ) {
    const t0 = Number(firstResponseT0);
    session.t0 = t0;
    if (!firstResponseByCall.has(String(callSid))) {
      firstResponseByCall.set(String(callSid), {
        t0,
        lastAt: session.firstResponseLastAt != null
          ? session.firstResponseLastAt
          : t0,
      });
    }
  }

  logFirstResponse(session, 'startLiveCall_started');

  // Wait for in-flight outbound prime (Gemini + greeting already starting).
  if (session.primePromise) {
    try {
      await session.primePromise;
    } catch {
      // Fall through to normal connect path.
    }
    session.primePromise = null;
  }

  // Primed path: attach Twilio WS and flush buffered greeting audio.
  if (session.liveSession) {
    session.twilioWs = twilioWs;
    session.streamSid = streamSid || session.streamSid;
    logFirstResponse(session, 'media_attached_to_prime');
    flushPendingOutboundPcm(session);
    callService.markAnswered(callSid, streamSid).catch(() => {});
    callService.markInProgress(callSid).catch(() => {});
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
    logger.info(
      'LIVE',
      `Live call attached to prime callSid=${callSid} streamSid=${streamSid}`
    );
    return session;
  }

  // Idempotent: never attach two Gemini Live sessions to one call.
  if (session.connecting || session.reconnecting) {
    logger.warn('LIVE', `start ignored — already connecting callSid=${callSid}`);
    return session;
  }

  session.connecting = true;
  clearReconnectTimer(session);

  try {
    await loadAgentOntoSession(session);
    logFirstResponse(session, 'agent_loading_completed');

    // Do not block Gemini connect/greeting on Mongo marks.
    const marksPromise = Promise.all([
      callService.markAnswered(callSid, streamSid),
      callService.markInProgress(callSid),
    ]).then(() => {
      logFirstResponse(session, 'markAnswered_completed');
      logFirstResponse(session, 'markInProgress_completed');
    });

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

    logFirstResponse(session, 'gemini_connect_started');
    const { liveSession, listenerEpoch } = await openGeminiLiveForCall(
      session,
      'start'
    );
    logFirstResponse(session, 'gemini_connected');

    // Race: call may have ended while connecting.
    if (session.ending || !sessions.has(callSid)) {
      closeLiveSessionQuietly(liveSession);
      await marksPromise.catch(() => {});
      return session;
    }

    if (session.liveSession) {
      // Should not happen given guards; close the extra socket.
      closeLiveSessionQuietly(liveSession);
      await marksPromise.catch(() => {});
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
      logFirstResponse(session, 'greeting_requested');
      logger.info('LIVE', `greeting requested once callSid=${callSid}`);
    }

    flushPendingOutboundPcm(session);

    logger.info(
      'LIVE',
      `Live call ready callSid=${callSid} streamSid=${streamSid} epoch=${listenerEpoch}`
    );
    await marksPromise.catch(() => {});
    return session;
  } finally {
    session.connecting = false;
  }
}

/**
 * Compute Twilio→Gemini audio path health (durations only; no payloads).
 * @param {object} session
 * @returns {{
 *   inboundFrames: number,
 *   geminiFrames: number,
 *   twilioMs: number,
 *   geminiMs: number,
 *   ratio: number,
 *   skipped: number,
 *   classification: 'ok'|'possible_drop'|'no_audio'
 * }}
 */
function computeAudioPathHealth(session) {
  const inboundFrames = Number(session && session.inboundMediaCount) || 0;
  const geminiFrames = Number(session && session.geminiInCount) || 0;
  const mulawBytes = Number(session && session.inboundMulawBytes) || 0;
  const pcmBytes = Number(session && session.geminiPcmBytes) || 0;
  const skipped = Number(session && session.audioForwardSkipped) || 0;
  // μ-law: 1 byte = 1 sample @ 8 kHz
  const twilioMs = mulawBytes > 0 ? (mulawBytes / 8000) * 1000 : 0;
  // PCM16: 2 bytes = 1 sample @ 16 kHz
  const geminiMs = pcmBytes > 0 ? (pcmBytes / 2 / 16000) * 1000 : 0;
  const ratio =
    twilioMs > 0 ? Math.round((geminiMs / twilioMs) * 1000) / 1000 : 0;
  let classification = 'no_audio';
  if (twilioMs > 0 || geminiMs > 0) {
    // Upsample loses ~1 sample/frame; ratio should stay near 1.0
    classification = ratio >= 0.95 && ratio <= 1.05 ? 'ok' : 'possible_drop';
  }
  return {
    inboundFrames,
    geminiFrames,
    twilioMs: Math.round(twilioMs),
    geminiMs: Math.round(geminiMs),
    ratio,
    skipped,
    classification,
  };
}

function logAudioPathHealth(session, reason = 'call_end') {
  if (!session) {
    return;
  }
  const h = computeAudioPathHealth(session);
  logger.info(
    'LIVE',
    `[AUDIO_PATH_HEALTH] callSid=${session.callSid || '?'} reason=${reason}` +
      ` inboundFrames=${h.inboundFrames} geminiFrames=${h.geminiFrames}` +
      ` twilioMs=${h.twilioMs} geminiMs=${h.geminiMs} ratio=${h.ratio}` +
      ` skipped=${h.skipped} class=${h.classification}` +
      ` waiting=${Boolean(session.waiting)}`
  );
}

/**
 * Ensure session has a PCM batch state (tests may omit createEmptySession).
 * @param {object} session
 */
function ensurePcmBatch(session) {
  if (!session) {
    return null;
  }
  if (!session.pcmBatch) {
    session.pcmBatch = createPcmBatchState(env.geminiPcmBatchMs);
  }
  return session.pcmBatch;
}

/**
 * Hooks that send batched PCM to the current Live session.
 * @param {object} session
 */
function pcmBatchHooks(session) {
  return {
    send(buf) {
      if (!session || !session.liveSession) {
        throw new Error('no_live_session');
      }
      geminiLiveService.sendPcm16kAudio(session.liveSession, buf);
    },
    scheduleFlush(ms, fn) {
      return setTimeout(fn, ms);
    },
    clearFlush(timer) {
      clearTimeout(timer);
    },
  };
}

/**
 * Flush any pending PCM batch. Does NOT send audioStreamEnd.
 * @param {object} session
 * @param {string} [reason]
 * @returns {number}
 */
function flushCallerPcmBatch(session, reason = 'flush') {
  const state = ensurePcmBatch(session);
  if (!state) {
    return 0;
  }
  return flushPcmBatch(state, pcmBatchHooks(session), reason);
}

function logAudioBatchHealth(session, reason = 'call_end') {
  if (!session) {
    return;
  }
  const state = ensurePcmBatch(session);
  const h = summarizePcmBatch(state);
  logger.info(
    'LIVE',
    `[AUDIO_BATCH_HEALTH] callSid=${session.callSid || '?'} reason=${reason}` +
      ` mode=${h.mode} input_ms=${h.inputMs} sent_ms=${h.sentMs}` +
      ` batches=${h.batches} flush_count=${h.flushCount}` +
      ` dropped_bytes=${h.droppedBytes} dropped_frames=${h.droppedFrames}` +
      ` pending_bytes=${h.pendingBytes} ratio=${h.ratio}`
  );
}

/**
 * Queue or immediately send caller PCM16k to Gemini (optional batching).
 * @param {object} session
 * @param {Buffer} pcm16k
 */
function sendCallerPcmToGemini(session, pcm16k) {
  const state = ensurePcmBatch(session);
  pushPcmBatch(state, pcm16k, pcmBatchHooks(session));
}

function forwardTwilioMedia(session, payloadBase64) {
  // waiting must NOT block PCM — only forwardAudio=false (call end) stops input.
  if (!session || !session.liveSession || !session.forwardAudio) {
    if (session) {
      session.audioForwardSkipped = (session.audioForwardSkipped || 0) + 1;
    }
    return;
  }
  if (!payloadBase64) {
    return;
  }
  try {
    session.inboundMediaCount = (session.inboundMediaCount || 0) + 1;
    session.lastCallerAudioAt = nowMs();
    const mulaw = Buffer.from(payloadBase64, 'base64');
    session.inboundMulawBytes =
      (session.inboundMulawBytes || 0) + mulaw.length;
    const pcm16k = mulaw8kToPcm16k(mulaw);

    if (!session.speechGate) {
      session.speechGate = createSpeechGateState();
    }

    // Gate labels speech for metrics/logging only — always stream real PCM
    // (incl. quiet frames) so Gemini Live VAD can complete user turns.
    const decision = evaluateFrame(pcm16k, session.speechGate, {
      aiSpeaking: Boolean(session.aiSpeaking),
      nowMs: nowMs(),
    });
    if (decision.accept) {
      session.speechLabeledCount = (session.speechLabeledCount || 0) + 1;
      stampCallerSpeechForLatency(session, nowMs());
      // Do NOT clear session.waiting here — hangover/noise frames must not
      // end WAIT. Resume only via onCallerUtterance (meaningful text).
      if (session.aiSpeaking) {
        logAudioGate(
          session,
          `interruption accepted reason=${decision.reason}`
        );
      } else if (decision.reason === 'caller_speech_accepted') {
        logAudioGate(
          session,
          `caller speech accepted reason=${decision.reason}`
        );
        logAudioGate(session, 'speech detected');
      } else if (decision.reason === 'hangover') {
        // stay quiet — hangover spam
      } else {
        logAudioGate(session, `speech detected reason=${decision.reason}`);
      }
    } else {
      session.gatedDropCount = (session.gatedDropCount || 0) + 1;
      if (
        decision.reason === 'below_min_duration' ||
        decision.reason === 'non_speech_energy' ||
        decision.reason === 'reopen_debounce'
      ) {
        const rejectedMs =
          (session.speechGate && session.speechGate.rejectedSpeechMs) || 0;
        logAudioGate(
          session,
          `background/noise labeled reason=${decision.reason} rejected_duration_ms=${rejectedMs}`
        );
      }
    }

    session.lastGeminiInAt = nowMs();
    session.geminiInCount = (session.geminiInCount || 0) + 1;
    session.geminiPcmBytes =
      (session.geminiPcmBytes || 0) + pcm16k.length;
    if (session.geminiInCount === 1 || session.geminiInCount % 200 === 0) {
      logger.info(
        'LIVE',
        `[AUDIO_IN][GEMINI_INPUT] callSid=${session.callSid} frames=${session.geminiInCount} waiting=${Boolean(session.waiting)}`
      );
    }
    // Optional batching: GEMINI_PCM_BATCH_MS=0 → immediate (default).
    // speechGate / WAIT never drop this PCM.
    sendCallerPcmToGemini(session, pcm16k);

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

  // Flush remaining optional PCM batch before closing input (not audioStreamEnd).
  flushCallerPcmBatch(session, 'end');
  logAudioBatchHealth(session, reason);

  const live = session.liveSession;
  session.liveSession = null;
  closeLiveSessionQuietly(live);

  try {
    await finalizeTranscripts(session);
  } catch {
    // ignore
  }

  const gate = session.speechGate || {};
  logAudioPathHealth(session, reason);
  logger.info(
    'LIVE',
    `stats callSid=${callSid} geminiChunks=${session.geminiChunkCount || 0} twilioFrames=${session.twilioFrameCount || 0} inbound=${session.inboundMediaCount || 0} geminiIn=${session.geminiInCount || 0} speechLabeled=${session.speechLabeledCount || 0} nonSpeechLabeled=${session.gatedDropCount || 0} gateFwd=${gate.forwardedFrames || 0}`
  );

  sessions.delete(callSid);
  clearFirstResponseTimeline(callSid);

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
  primeOutboundLive,
  forwardTwilioMedia,
  endLiveCall,
  clearTwilioPlayback,
  handleGeminiInterrupted,
  closeAllSessions,
  saveMessage,
  playGeminiPcmOnce,
  handleLiveMessage,
  handleLiveToolCalls,
  onCallerUtterance,
  maybeLogLatencyBreakdown,
  setNowMsForTests,
  resetOutboundReplyStamps,
  beginNewUserLatencyWindow,
  clearLatencyLogOnStartup,
  stampCallerSpeechForLatency,
  reconnectLiveSession,
  scheduleLiveReconnect,
  computeAudioPathHealth,
  logAudioPathHealth,
  flushCallerPcmBatch,
  logAudioBatchHealth,
  ensurePcmBatch,
  isSessionWaiting,
  LIVE_RECONNECT_MAX_ATTEMPTS,
  LATENCY_LOG_PATH,
  beginFirstResponseTimeline,
  getFirstResponseOrigin,
  stampFirstResponse,
  parseLiveMessageForTests: geminiLiveService.parseLiveMessage,
};
