'use strict';

const {
  GoogleGenAI,
  Modality,
  ActivityHandling,
  StartSensitivity,
  EndSensitivity,
} = require('@google/genai');
const { env } = require('../config/env');
const {
  buildSystemInstruction,
  FALLBACK_SPEECH,
} = require('../config/prompts');
const { DEFAULT_TIMEZONE } = require('../utils/timeOfDay');
const logger = require('../utils/logger');

/** @type {GoogleGenAI | null} */
let client = null;

const START_SENSITIVITY_VALUES = new Set(Object.values(StartSensitivity || {}));
const END_SENSITIVITY_VALUES = new Set(Object.values(EndSensitivity || {}));

function getClient() {
  if (!env.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }
  if (!client) {
    client = new GoogleGenAI({ apiKey: env.geminiApiKey });
  }
  return client;
}

function resolveStartSensitivity(value) {
  const raw = String(value || '').trim();
  if (START_SENSITIVITY_VALUES.has(raw)) {
    return raw;
  }
  const upper = raw.toUpperCase();
  if (upper === 'HIGH' || upper === 'START_SENSITIVITY_HIGH') {
    return StartSensitivity.START_SENSITIVITY_HIGH;
  }
  if (upper === 'LOW' || upper === 'START_SENSITIVITY_LOW') {
    return StartSensitivity.START_SENSITIVITY_LOW;
  }
  return StartSensitivity.START_SENSITIVITY_HIGH;
}

function resolveEndSensitivity(value) {
  const raw = String(value || '').trim();
  if (END_SENSITIVITY_VALUES.has(raw)) {
    return raw;
  }
  const upper = raw.toUpperCase();
  if (upper === 'HIGH' || upper === 'END_SENSITIVITY_HIGH') {
    return EndSensitivity.END_SENSITIVITY_HIGH;
  }
  if (upper === 'LOW' || upper === 'END_SENSITIVITY_LOW') {
    return EndSensitivity.END_SENSITIVITY_LOW;
  }
  return EndSensitivity.END_SENSITIVITY_HIGH;
}

/**
 * Build verified Gemini Live realtimeInputConfig for phone barge-in.
 * Uses @google/genai v1.52.0 enums only.
 */
function buildRealtimeInputConfig() {
  const prefixPaddingMs = Math.max(
    0,
    Number(env.vadPrefixPaddingMs) || 100
  );
  const silenceDurationMs = Math.max(
    100,
    Number(env.vadSilenceDurationMs) || 300
  );

  return {
    activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
    automaticActivityDetection: {
      disabled: false,
      startOfSpeechSensitivity: resolveStartSensitivity(env.vadStartSensitivity),
      endOfSpeechSensitivity: resolveEndSensitivity(env.vadEndSensitivity),
      prefixPaddingMs,
      silenceDurationMs,
    },
  };
}

/**
 * Build Live connect config for a phone call.
 * Requires caller-supplied systemInstruction (Mongo Agent.prompts combined).
 * @param {{
 *   systemInstruction: string,
 *   midCall?: boolean,
 *   sessionResumptionHandle?: string | null,
 * }} options
 */
function buildLiveConfig(options = {}) {
  const base = String(options.systemInstruction || '').trim();
  if (!base) {
    throw new Error('systemInstruction is required for Live session');
  }

  const systemInstruction = buildSystemInstruction(
    base,
    new Date(),
    DEFAULT_TIMEZONE,
    {
      midCall: Boolean(options.midCall),
    }
  );

  const realtimeInputConfig = buildRealtimeInputConfig();

  /** @type {Record<string, unknown>} */
  const sessionResumption = {};
  if (options.sessionResumptionHandle) {
    sessionResumption.handle = String(options.sessionResumptionHandle);
  }

  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction,
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName: env.geminiLiveVoice || 'Aoede',
        },
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig,
    // Long-call: compress context so audio sessions are not hard-capped.
    contextWindowCompression: {
      slidingWindow: {},
    },
    // Long-call: enable resumption tokens; pass handle when reconnecting.
    sessionResumption,
    // Knowledge RAG — Phase 1: explicit BLOCKING so 3.8 waits for tool response
    // (3.8 defaults to async/NON_BLOCKING). Do not add thinkingConfig (unsupported on 3.8 Live).
    tools: [
      {
        functionDeclarations: [
          {
            name: 'searchKnowledge',
            behavior: 'BLOCKING',
            description:
              'Search the company knowledge base for facts relevant to the caller question.',
            parameters: {
              type: 'OBJECT',
              properties: {
                query: {
                  type: 'STRING',
                  description:
                    "A concise search query representing the caller's factual question.",
                },
              },
              required: ['query'],
            },
          },
        ],
      },
    ],
  };
}

/**
 * Open a Gemini Live session.
 * @param {{
 *   onmessage: (msg: object) => void,
 *   onerror?: (err: ErrorEvent) => void,
 *   onclose?: (ev: CloseEvent) => void,
 *   onopen?: () => void,
 *   systemInstruction: string,
 *   midCall?: boolean,
 *   sessionResumptionHandle?: string | null,
 * }} handlers
 */
async function connectLiveSession(handlers) {
  const ai = getClient();
  const model = env.geminiLiveModel;
  const config = buildLiveConfig({
    systemInstruction: handlers.systemInstruction,
    midCall: handlers.midCall,
    sessionResumptionHandle: handlers.sessionResumptionHandle || null,
  });

  logger.info('LIVE', `Connecting Gemini Live model=${model}`);
  const searchDecl =
    config.tools &&
    config.tools[0] &&
    config.tools[0].functionDeclarations &&
    config.tools[0].functionDeclarations[0];
  logger.info(
    'LIVE',
    `tool searchKnowledge behavior=${
      (searchDecl && searchDecl.behavior) || 'unset'
    } thinkingConfig=${
      Object.prototype.hasOwnProperty.call(config, 'thinkingConfig')
        ? 'present'
        : 'absent'
    }`
  );
  logger.info(
    'LIVE',
    `VAD config=${JSON.stringify(config.realtimeInputConfig)}`
  );
  logger.info(
    'LIVE',
    `session mgmt compression=slidingWindow resumptionHandle=${
      handlers.sessionResumptionHandle ? 'yes' : 'new'
    }`
  );
  logger.info(
    'LIVE',
    `systemInstruction chars=${String(config.systemInstruction || '').length}`
  );
  logger.info(
    'MULTILINGUAL_DEBUG',
    `voiceLanguage_env=${env.voiceLanguage} usage=prompt_preferred_spoken_setting_only speechConfig_languageCode=none input_not_restricted_by_VOICE_LANGUAGE`
  );

  const session = await ai.live.connect({
    model,
    config,
    callbacks: {
      onopen: () => {
        logger.info('LIVE', 'Gemini Live socket open');
        if (typeof handlers.onopen === 'function') {
          handlers.onopen();
        }
      },
      onmessage: (message) => {
        handlers.onmessage(message);
      },
      onerror: (e) => {
        const msg = e && e.message ? e.message : 'Gemini Live error';
        logger.error('LIVE', msg);
        if (typeof handlers.onerror === 'function') {
          handlers.onerror(e);
        }
      },
      onclose: (e) => {
        logger.info(
          'LIVE',
          `Gemini Live closed reason=${(e && e.reason) || 'n/a'}`
        );
        if (typeof handlers.onclose === 'function') {
          handlers.onclose(e);
        }
      },
    },
  });

  return session;
}

/**
 * Send PCM16 @ 16kHz audio to Live as base64.
 * @param {import('@google/genai').Session} session
 * @param {Buffer} pcm16k
 */
function sendPcm16kAudio(session, pcm16k) {
  if (!session || !pcm16k || !pcm16k.length) {
    return;
  }
  session.sendRealtimeInput({
    audio: {
      data: pcm16k.toString('base64'),
      mimeType: 'audio/pcm;rate=16000',
    },
  });
}

/**
 * Ask Live to speak a tight exact line.
 * Disabled on the phone Live path (no business quick-facts bypass).
 * Kept for non-Live / test callers only.
 * @param {import('@google/genai').Session} session
 * @param {string} exactSpeech
 */
function speakExactLine(session, exactSpeech) {
  if (!session || !exactSpeech) {
    return;
  }
  session.sendClientContent({
    turns: [
      {
        role: 'user',
        parts: [
          {
            text: `Speak exactly this sentence and nothing else: ${exactSpeech}`,
          },
        ],
      },
    ],
    turnComplete: true,
  });
}

/**
 * Trigger opening greeting via text turn (Live speaks it).
 * @param {import('@google/genai').Session} session
 * @param {string} [greetingText]
 */
function requestGreeting(session, greetingText) {
  if (!session) {
    return;
  }
  session.sendClientContent({
    turns: [
      {
        role: 'user',
        parts: [
          {
            text:
              greetingText ||
              'Produce a brief opening response using the configured system instructions.',
          },
        ],
      },
    ],
    turnComplete: true,
  });
}

/**
 * Reply to a Live toolCall with FunctionResponse objects.
 * Gemini Live waits synchronously for this before continuing generation.
 * @param {import('@google/genai').Session} session
 * @param {object|object[]} functionResponses
 */
function sendToolResponse(session, functionResponses) {
  if (!session || typeof session.sendToolResponse !== 'function') {
    return;
  }
  const list = Array.isArray(functionResponses)
    ? functionResponses
    : [functionResponses];
  if (!list.length) {
    return;
  }
  session.sendToolResponse({ functionResponses: list });
}

/**
 * Extract audio PCM buffers and transcriptions from a Live server message.
 *
 * CRITICAL: Do NOT also read `message.data`.
 * On LiveServerMessage, `data` is an SDK getter that re-encodes the same
 * inlineData parts — using both causes every audio chunk to play twice.
 *
 * @param {object} message
 */
function parseLiveMessage(message) {
  const result = {
    interrupted: false,
    turnComplete: false,
    inputTranscription: '',
    interimInputTranscription: '',
    outputTranscription: '',
    inputFinished: false,
    outputFinished: false,
    userActivityEnd: false,
    audioBuffers: [],
    goAway: null,
    sessionResumptionUpdate: null,
    functionCalls: [],
  };

  if (!message || typeof message !== 'object') {
    return result;
  }

  if (message.goAway && typeof message.goAway === 'object') {
    result.goAway = {
      timeLeft: message.goAway.timeLeft != null ? String(message.goAway.timeLeft) : null,
    };
  }

  if (
    message.sessionResumptionUpdate &&
    typeof message.sessionResumptionUpdate === 'object'
  ) {
    const u = message.sessionResumptionUpdate;
    result.sessionResumptionUpdate = {
      newHandle: u.newHandle != null ? String(u.newHandle) : null,
      resumable: Boolean(u.resumable),
      lastConsumedClientMessageIndex:
        u.lastConsumedClientMessageIndex != null
          ? String(u.lastConsumedClientMessageIndex)
          : null,
    };
  }

  // Live root toolCall (synchronous function calling).
  const rootCalls =
    message.toolCall && Array.isArray(message.toolCall.functionCalls)
      ? message.toolCall.functionCalls
      : [];
  for (const fc of rootCalls) {
    if (!fc || !fc.name) continue;
    let args = fc.args || fc.arguments || {};
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = { query: args };
      }
    }
    result.functionCalls.push({
      id: fc.id != null ? String(fc.id) : undefined,
      name: String(fc.name),
      args: args && typeof args === 'object' ? args : {},
    });
  }

  // Prefer explicit server voice-activity end when present (Gemini Live VAD).
  const va = message.voiceActivity;
  if (va && typeof va === 'object') {
    const vat = String(va.voiceActivityType || va.type || '');
    if (vat.includes('ACTIVITY_END') || vat === 'ACTIVITY_END') {
      result.userActivityEnd = true;
    }
  }
  const vadSig = message.voiceActivityDetectionSignal;
  if (vadSig && typeof vadSig === 'object') {
    const vst = String(vadSig.vadSignalType || '');
    if (vst.includes('END') || vst.includes('STOP')) {
      result.userActivityEnd = true;
    }
  }

  const sc = message.serverContent;
  // Transcriptions may appear on serverContent and/or message root (API variants).
  const inputTx =
    (sc && sc.inputTranscription) || message.inputTranscription || null;
  const interimTx =
    (sc && sc.interimInputTranscription) ||
    message.interimInputTranscription ||
    null;
  const outputTx =
    (sc && sc.outputTranscription) || message.outputTranscription || null;

  if (inputTx && inputTx.text) {
    result.inputTranscription = String(inputTx.text);
    result.inputFinished = Boolean(inputTx.finished);
  }
  if (inputTx && inputTx.finished) {
    result.inputFinished = true;
  }
  if (interimTx && interimTx.text) {
    result.interimInputTranscription = String(interimTx.text);
  }
  if (outputTx && outputTx.text) {
    result.outputTranscription = String(outputTx.text);
    result.outputFinished = Boolean(outputTx.finished);
  }
  if (outputTx && outputTx.finished) {
    result.outputFinished = true;
  }

  if (!sc || typeof sc !== 'object') {
    return result;
  }

  if (sc.interrupted) {
    result.interrupted = true;
  }
  if (sc.turnComplete) {
    result.turnComplete = true;
  }

  const parts =
    sc.modelTurn && Array.isArray(sc.modelTurn.parts)
      ? sc.modelTurn.parts
      : [];

  for (const part of parts) {
    if (!part) continue;
    if (part.functionCall && part.functionCall.name) {
      const fc = part.functionCall;
      let args = fc.args || fc.arguments || {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = { query: args };
        }
      }
      result.functionCalls.push({
        id: fc.id != null ? String(fc.id) : undefined,
        name: String(fc.name),
        args: args && typeof args === 'object' ? args : {},
      });
      continue;
    }
    const inline = part.inlineData || part.inline_data;
    if (inline && inline.data && typeof inline.data === 'string') {
      const mime = String(inline.mimeType || inline.mime_type || '');
      if (!mime || mime.includes('audio') || mime.includes('pcm')) {
        result.audioBuffers.push(Buffer.from(inline.data, 'base64'));
      }
    }
  }

  return result;
}

module.exports = {
  connectLiveSession,
  sendPcm16kAudio,
  speakExactLine,
  requestGreeting,
  sendToolResponse,
  parseLiveMessage,
  buildLiveConfig,
  buildRealtimeInputConfig,
  FALLBACK_SPEECH,
  getClient,
};
