'use strict';

const { Message } = require('../models/Message');
const { isDatabaseConnected } = require('../config/database');
const callService = require('./callService');
const dashboardSocket = require('../websocket/dashboardSocket');
const geminiLiveService = require('./geminiLiveService');
const { matchQuickFact } = require('./companyQuickFacts');
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
const { env } = require('../config/env');
const { getTimeOfDay, DEFAULT_TIMEZONE } = require('../utils/timeOfDay');
const logger = require('../utils/logger');

/** @type {Map<string, object>} */
const sessions = new Map();

function nowMs() {
  return Date.now();
}

function elapsedMs(session) {
  if (!session || !session.t0) return 0;
  return nowMs() - session.t0;
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
    turnFirstAudioLogged: false,
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
    session.turnFirstAudioLogged = true;
    logger.info(
      'LATENCY',
      `gemini_first_audio call=${session.callSid} t+${elapsedMs(session)}ms chunk=${chunkId}`
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
    } catch (error) {
      logger.warn('LIVE', `Twilio media send failed: ${error.message}`);
      break;
    }
  }
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

  const generation = session.playbackGeneration;
  for (const pcm of parsed.audioBuffers) {
    playGeminiPcmOnce(session, pcm, generation);
  }

  if (parsed.turnComplete) {
    session.aiSpeaking = false;
    session.turnFirstAudioLogged = false;
  }

  if (parsed.inputTranscription) {
    session.inputTranscriptBuffer =
      (session.inputTranscriptBuffer || '') + parsed.inputTranscription;
    if (parsed.inputFinished) {
      session.lastUserTurnEndAt = nowMs();
      flushInputTranscript(session).catch((error) => {
        logger.error('LIVE', `flushInputTranscript: ${error.message}`);
      });
    }
  }

  if (parsed.outputTranscription) {
    session.outputTranscriptBuffer =
      (session.outputTranscriptBuffer || '') + parsed.outputTranscription;
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

async function flushInputTranscript(session) {
  const input = (session.inputTranscriptBuffer || '').trim();
  session.inputTranscriptBuffer = '';
  if (!input) {
    return;
  }
  await onCallerUtterance(session, input);
}

async function flushOutputTranscript(session) {
  const output = (session.outputTranscriptBuffer || '').trim();
  session.outputTranscriptBuffer = '';
  if (!output || session.waiting) {
    return;
  }
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

  const fact = matchQuickFact(text);
  if (fact && session.liveSession) {
    logger.info('LIVE', `quick-fact=${fact.id} callSid=${session.callSid}`);
    clearTwilioPlayback(session);
    geminiLiveService.speakExactLine(session.liveSession, fact.answer);
  }
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
  if (session.connecting) {
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

  try {
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

    session.liveSessionEpoch = (session.liveSessionEpoch || 0) + 1;
    const listenerEpoch = session.liveSessionEpoch;

    logger.info(
      'LIVE',
      `connect callSid=${callSid} streamSid=${streamSid} epoch=${listenerEpoch}`
    );

    const liveSession = await geminiLiveService.connectLiveSession({
      midCall: false,
      onmessage: (message) => {
        const current = sessions.get(callSid);
        if (current) {
          handleLiveMessage(current, message, listenerEpoch);
        }
      },
      onerror: () => {
        logger.error('LIVE', `session error callSid=${callSid} epoch=${listenerEpoch}`);
      },
      onclose: () => {
        logger.info(
          'LIVE',
          `session closed callSid=${callSid} epoch=${listenerEpoch}`
        );
      },
    });

    // Race: call may have ended while connecting.
    if (session.ending || !sessions.has(callSid)) {
      closeLiveSessionQuietly(liveSession);
      return session;
    }

    session.liveSession = liveSession;

    if (!session.greeted) {
      session.greeted = true;
      const { greeting, helpWhen } = getTimeOfDay(new Date(), DEFAULT_TIMEZONE);
      const name = env.chatbotName || 'Parker';
      geminiLiveService.requestGreeting(
        liveSession,
        `The phone call just connected. Speak a brief opening only: "${greeting}! This is ${name} from JPLoft. How can I help you ${helpWhen}?" Do not add anything else.`
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
  parseLiveMessageForTests: geminiLiveService.parseLiveMessage,
};
