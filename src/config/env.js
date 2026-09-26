'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });

function toWssBase(publicBaseUrl) {
  if (!publicBaseUrl) {
    return '';
  }
  return publicBaseUrl
    .replace(/^http:/i, 'ws:')
    .replace(/^https:/i, 'wss:')
    .replace(/\/$/, '');
}

const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';
const wssBase = toWssBase(publicBaseUrl);

const env = {
  port: Number(process.env.PORT) || 3000,
  nodeEnv: process.env.NODE_ENV || 'development',
  twilioAccountSid: process.env.TWILIO_ACCOUNT_SID || '',
  twilioAuthToken: process.env.TWILIO_AUTH_TOKEN || '',
  twilioPhoneNumber: process.env.TWILIO_PHONE_NUMBER || '',
  publicBaseUrl,
  // Deprecated for phone path (ConversationRelay). Kept for backward-compatible docs only.
  conversationRelayWsUrl: process.env.CONVERSATION_RELAY_WS_URL || '',
  mediaStreamWsUrl:
    process.env.MEDIA_STREAM_WS_URL ||
    (wssBase ? `${wssBase}/media-stream` : ''),
  mongodbUri:
    process.env.MONGODB_URI ||
    'mongodb://127.0.0.1:27017/twilio_ai_voice_agent',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  geminiLiveModel:
    process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
  geminiLiveVoice: process.env.GEMINI_LIVE_VOICE || 'Aoede',
  /** Never use text-embedding-004 (shutdown Jan 2026). */
  geminiEmbeddingModel:
    process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2',
  /** Keep query + document embeddings on the same dimensionality. */
  geminiEmbeddingDimensions:
    Number(process.env.GEMINI_EMBEDDING_DIMENSIONS) || 768,
  knowledgeMinScore: Number(process.env.KNOWLEDGE_MIN_SCORE) || 0,
  knowledgeTopK: Number(process.env.KNOWLEDGE_TOP_K) || 3,
  knowledgeMaxChars: Number(process.env.KNOWLEDGE_MAX_CHARS) || 3000,
  voiceLanguage: process.env.VOICE_LANGUAGE || 'en-US',
  chatbotName: process.env.CHATBOT_NAME || '',
  dashboardWsUrl: process.env.DASHBOARD_WS_URL || '',
  skipTwilioSignature:
    String(process.env.SKIP_TWILIO_SIGNATURE || '').toLowerCase() === 'true',
  vadStartSensitivity: process.env.VAD_START_SENSITIVITY || 'LOW',
  vadEndSensitivity: process.env.VAD_END_SENSITIVITY || 'HIGH',
  vadPrefixPaddingMs: Number(process.env.VAD_PREFIX_PADDING_MS) || 150,
  vadSilenceDurationMs: Number(process.env.VAD_SILENCE_DURATION_MS) || 500,
  /** How long a recent barge-in gate accept remains valid for Twilio clear. */
  bargeInConfirmWindowMs:
    Number(process.env.BARGE_IN_CONFIRM_MS) || 480,
  /** Min ms between Twilio clear events on interrupt. */
  bargeInClearDebounceMs:
    Number(process.env.BARGE_IN_CLEAR_DEBOUNCE_MS) || 500,
  /**
   * Optional Gemini Live PCM input batching (ms). Default 0 = send each
   * Twilio frame immediately (current production behavior). Set to 100 for
   * the ~100 ms ASR experiment. Never enable by default without evidence.
   */
  geminiPcmBatchMs: Math.max(
    0,
    Math.floor(Number(process.env.GEMINI_PCM_BATCH_MS) || 0)
  ),
  /**
   * Phone audio brain: `live` = Gemini Live (rollback).
   * `classic` = Deepgram Flux STT → Gemini text + RAG → ElevenLabs TTS.
   * Unset stays `live` so existing calls keep working until keys are set.
   */
  voicePipeline:
    String(process.env.VOICE_PIPELINE || 'live').toLowerCase() === 'classic'
      ? 'classic'
      : 'live',
  deepgramApiKey: process.env.DEEPGRAM_API_KEY || '',
  deepgramFluxModel: process.env.DEEPGRAM_FLUX_MODEL || 'flux-general-en',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY || '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID || '',
  elevenLabsModel: process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5',
  outboundAmbienceEnabled:
    String(process.env.OUTBOUND_AMBIENCE_ENABLED || '').toLowerCase() ===
    'true',
  outboundAmbienceGain: Math.min(
    1,
    Math.max(0, Number(process.env.OUTBOUND_AMBIENCE_GAIN) || 0.08)
  ),
};

function getVoiceWebhookUrl() {
  if (!env.publicBaseUrl) {
    return '';
  }
  return `${env.publicBaseUrl.replace(/\/$/, '')}/voice`;
}

function getOutboundVoiceWebhookUrl() {
  if (!env.publicBaseUrl) {
    return '';
  }
  return `${env.publicBaseUrl.replace(/\/$/, '')}/voice/outbound`;
}

function getOutboundStatusCallbackUrl() {
  if (!env.publicBaseUrl) {
    return '';
  }
  return `${env.publicBaseUrl.replace(/\/$/, '')}/voice/outbound-status`;
}

function getOutboundGreetingPlayUrl(callSid) {
  if (!env.publicBaseUrl || !callSid) {
    return '';
  }
  return `${env.publicBaseUrl.replace(/\/$/, '')}/voice/outbound-greeting/${encodeURIComponent(callSid)}`;
}

function getMediaStreamWsUrl() {
  return env.mediaStreamWsUrl || '';
}

module.exports = {
  env,
  getVoiceWebhookUrl,
  getOutboundVoiceWebhookUrl,
  getOutboundStatusCallbackUrl,
  getOutboundGreetingPlayUrl,
  getMediaStreamWsUrl,
};
