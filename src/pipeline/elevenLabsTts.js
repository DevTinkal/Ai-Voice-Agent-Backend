'use strict';

const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Stream ElevenLabs PCM16 @ 24 kHz.
 * @param {string} text
 * @param {{ voiceId?: string, apiKey?: string, fetchImpl?: typeof fetch, signal?: AbortSignal }} [options]
 * @returns {Promise<Buffer>}
 */
async function synthesizePcm24k(text, options = {}) {
  const spoken = String(text || '').trim();
  if (!spoken) return Buffer.alloc(0);
  const apiKey = options.apiKey || env.elevenLabsApiKey;
  const voiceId = options.voiceId || env.elevenLabsVoiceId;
  if (!apiKey || !voiceId) {
    throw new Error('ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID are required');
  }
  const fetchImpl = options.fetchImpl || fetch;
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
    voiceId
  )}/stream?output_format=pcm_24000`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/pcm',
    },
    body: JSON.stringify({
      text: spoken,
      model_id: env.elevenLabsModel || 'eleven_flash_v2_5',
    }),
    signal: options.signal,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ElevenLabs ${response.status} ${body.slice(0, 180)}`);
  }
  const arrayBuf = await response.arrayBuffer();
  const pcm = Buffer.from(arrayBuf);
  logger.info('TTS', `elevenlabs bytes=${pcm.length} chars=${spoken.length}`);
  return pcm;
}

function splitSpeakableSentences(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  const parts = raw.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : [raw];
}

module.exports = {
  synthesizePcm24k,
  splitSpeakableSentences,
};
