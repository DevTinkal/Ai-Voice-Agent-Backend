'use strict';

/**
 * Lightweight speech / noise labeler for phone PCM16 @ 16 kHz.
 * Adaptive noise floor + RMS margin + speech-like zero-crossing rate.
 * Labels speech for diagnostics — Live always receives continuous PCM
 * (including silence) so Gemini VAD can end turns. Not speaker ID.
 */

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
/** Must exceed Gemini VAD silenceDurationMs (300) so labels stay open through end-of-turn. */
const HANGOVER_MS = 450;
const OPEN_THRESHOLD_MS = 50;

function createSpeechGateState() {
  return {
    noiseFloor: 200, // initial RMS estimate for quiet telephony line
    open: false,
    speechMs: 0,
    hangoverMs: 0,
    forwardedFrames: 0,
    droppedFrames: 0,
  };
}

function frameRms(pcm16) {
  const samples = Math.floor(pcm16.length / 2);
  if (samples === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i += 1) {
    const s = pcm16.readInt16LE(i * 2);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / samples);
}

function zeroCrossingRate(pcm16) {
  const samples = Math.floor(pcm16.length / 2);
  if (samples < 2) return 0;
  let crossings = 0;
  let prev = pcm16.readInt16LE(0);
  for (let i = 1; i < samples; i += 1) {
    const cur = pcm16.readInt16LE(i * 2);
    if ((prev >= 0 && cur < 0) || (prev < 0 && cur >= 0)) {
      crossings += 1;
    }
    prev = cur;
  }
  return crossings / (samples - 1);
}

/**
 * Label whether this frame looks like speech (for metrics only).
 * Session layer always sends PCM to Gemini regardless of return value.
 *
 * @param {Buffer} pcm16k
 * @param {ReturnType<typeof createSpeechGateState>} state
 * @param {{ nowMs?: number }} [opts]
 * @returns {boolean} true when gate considers the frame speech / hangover
 */
function shouldForward(pcm16k, state, opts = {}) {
  if (!state || !pcm16k || !pcm16k.length) {
    return false;
  }

  const rms = frameRms(pcm16k);
  const zcr = zeroCrossingRate(pcm16k);
  const frameMs = Math.max(
    10,
    Math.round((Math.floor(pcm16k.length / 2) / SAMPLE_RATE) * 1000) || FRAME_MS
  );

  // Adaptive noise floor from quiet frames only.
  const quiet = rms < state.noiseFloor * 1.35;
  if (quiet) {
    state.noiseFloor = state.noiseFloor * 0.95 + rms * 0.05;
  } else if (rms < state.noiseFloor * 0.8) {
    state.noiseFloor = state.noiseFloor * 0.98 + rms * 0.02;
  }
  // Keep floor in a sane telephony band.
  state.noiseFloor = Math.min(2000, Math.max(60, state.noiseFloor));

  // Softer margin so quiet phone "hi" still labels as speech.
  const threshold = state.noiseFloor + Math.max(100, state.noiseFloor * 0.4);
  // Speech typically has moderate ZCR; pure tones / clicks differ.
  const speechLike = zcr >= 0.015 && zcr <= 0.4;
  const energetic = rms >= threshold;

  if (energetic && speechLike) {
    state.speechMs += frameMs;
  } else {
    state.speechMs = Math.max(0, state.speechMs - frameMs * 0.5);
  }

  if (!state.open && state.speechMs >= OPEN_THRESHOLD_MS) {
    state.open = true;
    state.hangoverMs = HANGOVER_MS;
  }

  if (state.open) {
    if (energetic && speechLike) {
      state.hangoverMs = HANGOVER_MS;
    } else {
      state.hangoverMs -= frameMs;
      if (state.hangoverMs <= 0) {
        state.open = false;
        state.speechMs = 0;
      }
    }
  }

  if (state.open) {
    state.forwardedFrames += 1;
    return true;
  }
  state.droppedFrames += 1;
  return false;
}

module.exports = {
  SAMPLE_RATE,
  HANGOVER_MS,
  OPEN_THRESHOLD_MS,
  createSpeechGateState,
  shouldForward,
  frameRms,
  zeroCrossingRate,
};
