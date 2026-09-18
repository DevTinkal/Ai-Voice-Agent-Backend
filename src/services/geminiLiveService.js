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
 * @param {{ midCall?: boolean }} [options]
 */
function buildLiveConfig(options = {}) {
  const systemInstruction = buildSystemInstruction(
    new Date(),
    DEFAULT_TIMEZONE,
    {
      midCall: Boolean(options.midCall),
      chatbotName: env.chatbotName,
    }
  );

  const realtimeInputConfig = buildRealtimeInputConfig();

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
  };
}

/**
 * Open a Gemini Live session.
 * @param {{
 *   onmessage: (msg: object) => void,
 *   onerror?: (err: ErrorEvent) => void,
 *   onclose?: (ev: CloseEvent) => void,
 *   onopen?: () => void,
 *   midCall?: boolean,
 * }} handlers
 */
async function connectLiveSession(handlers) {
  const ai = getClient();
  const model = env.geminiLiveModel;
  const config = buildLiveConfig({ midCall: handlers.midCall });

  logger.info('LIVE', `Connecting Gemini Live model=${model}`);
  logger.info(
    'LIVE',
    `VAD config=${JSON.stringify(config.realtimeInputConfig)}`
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
 * Ask Live to speak a tight exact line (quick-facts path).
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
 * @param {string} greetingText
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
              'The call just connected. Greet the caller briefly as instructed and ask how you can help.',
          },
        ],
      },
    ],
    turnComplete: true,
  });
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
    outputTranscription: '',
    inputFinished: false,
    outputFinished: false,
    audioBuffers: [],
  };

  if (!message || typeof message !== 'object') {
    return result;
  }

  const sc = message.serverContent;
  if (!sc || typeof sc !== 'object') {
    return result;
  }

  if (sc.interrupted) {
    result.interrupted = true;
  }
  if (sc.turnComplete) {
    result.turnComplete = true;
  }
  if (sc.inputTranscription && sc.inputTranscription.text) {
    result.inputTranscription = String(sc.inputTranscription.text);
    result.inputFinished = Boolean(sc.inputTranscription.finished);
  }
  if (sc.outputTranscription && sc.outputTranscription.text) {
    result.outputTranscription = String(sc.outputTranscription.text);
    result.outputFinished = Boolean(sc.outputTranscription.finished);
  }

  const parts =
    sc.modelTurn && Array.isArray(sc.modelTurn.parts)
      ? sc.modelTurn.parts
      : [];

  for (const part of parts) {
    if (!part) continue;
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
  parseLiveMessage,
  buildLiveConfig,
  buildRealtimeInputConfig,
  FALLBACK_SPEECH,
  getClient,
};
