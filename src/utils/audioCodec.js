'use strict';

/**
 * Pure-JS μ-law (G.711) and PCM resampling helpers for Twilio Media Streams ↔ Gemini Live.
 * Twilio: 8 kHz μ-law mono
 * Gemini Live input: 16-bit PCM LE @ 16 kHz
 * Gemini Live output: 16-bit PCM LE @ 24 kHz
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const TWILIO_FRAME_BYTES = 160; // 20ms @ 8kHz μ-law

const MULAW_DECODE_TABLE = new Int16Array(256);
for (let i = 0; i < 256; i += 1) {
  let mu = ~i & 0xff;
  const sign = mu & 0x80;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}

function encodeMulawSample(sample) {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) {
    s = -s;
  }
  if (s > MULAW_CLIP) {
    s = MULAW_CLIP;
  }
  s += MULAW_BIAS;

  let exponent = 7;
  for (
    let expMask = 0x4000;
    (s & expMask) === 0 && exponent > 0;
    exponent -= 1, expMask >>= 1
  ) {
    // find exponent
  }
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawToPcm16(mulawBuffer) {
  const input = Buffer.isBuffer(mulawBuffer)
    ? mulawBuffer
    : Buffer.from(mulawBuffer);
  const out = Buffer.alloc(input.length * 2);
  for (let i = 0; i < input.length; i += 1) {
    out.writeInt16LE(MULAW_DECODE_TABLE[input[i]], i * 2);
  }
  return out;
}

function pcm16ToMulaw(pcmBuffer) {
  const input = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
  const sampleCount = Math.floor(input.length / 2);
  const out = Buffer.alloc(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) {
    out[i] = encodeMulawSample(input.readInt16LE(i * 2));
  }
  return out;
}

/**
 * Upsample PCM16 by integer factor without duplicating whole frames.
 * Each input sample maps to `factor` output samples via linear interpolation.
 */
function upsamplePcm16(pcmBuffer, factor = 2) {
  const input = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
  const inSamples = Math.floor(input.length / 2);
  if (inSamples === 0) {
    return Buffer.alloc(0);
  }
  if (inSamples === 1) {
    const sample = input.readInt16LE(0);
    const out = Buffer.alloc(factor * 2);
    for (let f = 0; f < factor; f += 1) {
      out.writeInt16LE(sample, f * 2);
    }
    return out;
  }

  const outSamples = (inSamples - 1) * factor + 1;
  const out = Buffer.alloc(outSamples * 2);
  let outIndex = 0;
  for (let i = 0; i < inSamples - 1; i += 1) {
    const a = input.readInt16LE(i * 2);
    const b = input.readInt16LE((i + 1) * 2);
    for (let f = 0; f < factor; f += 1) {
      const t = f / factor;
      out.writeInt16LE(Math.round(a + (b - a) * t), outIndex * 2);
      outIndex += 1;
    }
  }
  out.writeInt16LE(input.readInt16LE((inSamples - 1) * 2), outIndex * 2);
  return out;
}

/**
 * Downsample PCM16 from fromRate to toRate by averaging windows.
 * Does not repeat sample windows.
 */
function resamplePcm16(pcmBuffer, fromRate, toRate) {
  const input = Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer);
  const inSamples = Math.floor(input.length / 2);
  if (inSamples === 0 || fromRate === toRate) {
    return Buffer.from(input);
  }

  if (fromRate * 2 === toRate) {
    return upsamplePcm16(input, 2);
  }

  const ratio = fromRate / toRate;
  const outSamples = Math.floor(inSamples / ratio);
  const out = Buffer.alloc(outSamples * 2);

  for (let i = 0; i < outSamples; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.min(inSamples, Math.floor((i + 1) * ratio) || start + 1);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j += 1) {
      sum += input.readInt16LE(j * 2);
      count += 1;
    }
    out.writeInt16LE(count ? Math.round(sum / count) : 0, i * 2);
  }
  return out;
}

function mulaw8kToPcm16k(mulawBuffer) {
  const pcm8k = mulawToPcm16(mulawBuffer);
  return resamplePcm16(pcm8k, 8000, 16000);
}

function pcm24kToMulaw8k(pcm24kBuffer) {
  // Two-step downsample (24k→16k→8k) for cleaner telephony audio.
  const pcm16k = resamplePcm16(pcm24kBuffer, 24000, 16000);
  const pcm8k = resamplePcm16(pcm16k, 16000, 8000);
  return pcm16ToMulaw(pcm8k);
}

/**
 * Split μ-law into exact 160-byte Twilio frames.
 * Returns { frames, remainder } — remainder must be carried to the next chunk.
 * Frames are copied Buffers (not shared subarrays).
 */
function chunkMulawForTwilio(mulawBuffer, frameBytes = TWILIO_FRAME_BYTES, priorRemainder = null) {
  const parts = [];
  if (priorRemainder && priorRemainder.length) {
    parts.push(priorRemainder);
  }
  if (mulawBuffer && mulawBuffer.length) {
    parts.push(Buffer.isBuffer(mulawBuffer) ? mulawBuffer : Buffer.from(mulawBuffer));
  }
  const input = parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
  const frames = [];
  let offset = 0;
  while (offset + frameBytes <= input.length) {
    frames.push(Buffer.from(input.subarray(offset, offset + frameBytes)));
    offset += frameBytes;
  }
  const remainder =
    offset < input.length ? Buffer.from(input.subarray(offset)) : Buffer.alloc(0);
  return { frames, remainder };
}

module.exports = {
  TWILIO_FRAME_BYTES,
  mulawToPcm16,
  pcm16ToMulaw,
  upsamplePcm16,
  resamplePcm16,
  mulaw8kToPcm16k,
  pcm24kToMulaw8k,
  chunkMulawForTwilio,
};
