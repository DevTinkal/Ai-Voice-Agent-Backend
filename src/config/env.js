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
    process.env.GEMINI_LIVE_MODEL || 'gemini-3.1-flash-live-preview',
  geminiLiveVoice: process.env.GEMINI_LIVE_VOICE || 'Aoede',
  voiceLanguage: process.env.VOICE_LANGUAGE || 'en-US',
  chatbotName: process.env.CHATBOT_NAME || 'Parker',
  dashboardWsUrl: process.env.DASHBOARD_WS_URL || '',
  skipTwilioSignature:
    String(process.env.SKIP_TWILIO_SIGNATURE || '').toLowerCase() === 'true',
  vadStartSensitivity: process.env.VAD_START_SENSITIVITY || 'HIGH',
  vadEndSensitivity: process.env.VAD_END_SENSITIVITY || 'HIGH',
  vadPrefixPaddingMs: Number(process.env.VAD_PREFIX_PADDING_MS) || 100,
  vadSilenceDurationMs: Number(process.env.VAD_SILENCE_DURATION_MS) || 300,
};

function getVoiceWebhookUrl() {
  if (!env.publicBaseUrl) {
    return '';
  }
  return `${env.publicBaseUrl.replace(/\/$/, '')}/voice`;
}

function getMediaStreamWsUrl() {
  return env.mediaStreamWsUrl || '';
}

module.exports = {
  env,
  getVoiceWebhookUrl,
  getMediaStreamWsUrl,
};
