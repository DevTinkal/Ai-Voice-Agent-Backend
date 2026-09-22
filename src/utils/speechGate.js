'use strict';

/**
 * Speech / noise gate for phone PCM16 @ 16 kHz.
 * Adaptive noise floor + RMS margin + speech-like zero-crossing rate.
 *
 * Metrics + barge-in confirmation only. Caller PCM always reaches Gemini Live
 * (no silence replacement). This is NOT speaker identification / diarization —
 * a loud nearby talker on the same mic can still pass.
 */

const SAMPLE_RATE = 16000;
const FRAME_MS = 20;
/** Must exceed Gemini VAD silenceDurationMs so hangover covers end-of-turn. */
const HANGOVER_MS = 450;
/** Idle path: reject short clicks / TV blips before opening. */
const MIN_OPEN_MS_IDLE = 150;
/** AI speaking: open soon enough for "Wait!" but filter clicks (was 70). */
const MIN_OPEN_MS_BARGE_IN = 120;
/** After close, ignore brief re-energy for this long (idle only). */
const REOPEN_DEBOUNCE_MS = 120;
/** Legacy alias used by older callers/tests. */
const OPEN_THRESHOLD_MS = MIN_OPEN_MS_IDLE;

function createSpeechGateState() {
  return {
    noiseFloor: 200, // initial RMS estimate for quiet telephony line
    open: false,
    speechMs: 0,
    hangoverMs: 0,
    /** ms since last close; used for reopen debounce */
    closedMs: REOPEN_DEBOUNCE_MS,
    forwardedFrames: 0,
    droppedFrames: 0,
    lastReason: 'init',
    rejectedSpeechMs: 0,
    /** Wall clock when gate last accepted while AI was speaking. */
    lastBargeAcceptAt: 0,
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
 * Evaluate one PCM frame.
 * @param {Buffer} pcm16k
 * @param {ReturnType<typeof createSpeechGateState>} state
 * @param {{ aiSpeaking?: boolean, nowMs?: number }} [opts]
 * @returns {{ accept: boolean, reason: string, speechMs: number, open: boolean }}
 */
function evaluateFrame(pcm16k, state, opts = {}) {
  if (!state || !pcm16k || !pcm16k.length) {
    return {
      accept: false,
      reason: 'invalid_frame',
      speechMs: 0,
      open: false,
    };
  }

  const aiSpeaking = Boolean(opts.aiSpeaking);
  const minOpenMs = aiSpeaking ? MIN_OPEN_MS_BARGE_IN : MIN_OPEN_MS_IDLE;
  const now =
    typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs)
      ? opts.nowMs
      : Date.now();

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
  state.noiseFloor = Math.min(2000, Math.max(60, state.noiseFloor));

  const threshold = state.noiseFloor + Math.max(100, state.noiseFloor * 0.4);
  // Speech typically has moderate ZCR; pure tones / clicks / hiss differ.
  const speechLike = zcr >= 0.015 && zcr <= 0.4;
  const energetic = rms >= threshold;
  const candidate = energetic && speechLike;

  if (!state.open) {
    state.closedMs = (state.closedMs || 0) + frameMs;
  }

  if (candidate) {
    state.speechMs += frameMs;
  } else {
    state.speechMs = Math.max(0, state.speechMs - frameMs * 0.5);
    if (energetic && !speechLike) {
      state.lastReason = 'non_speech_energy';
      state.rejectedSpeechMs = (state.rejectedSpeechMs || 0) + frameMs;
    }
  }

  const debounceOk = aiSpeaking || state.closedMs >= REOPEN_DEBOUNCE_MS;

  if (!state.open && candidate && state.speechMs >= minOpenMs && debounceOk) {
    state.open = true;
    state.hangoverMs = HANGOVER_MS;
    state.closedMs = 0;
    state.lastReason = aiSpeaking ? 'interruption_accepted' : 'caller_speech_accepted';
    if (aiSpeaking) {
      state.lastBargeAcceptAt = now;
    }
  } else if (!state.open && candidate && state.speechMs < minOpenMs) {
    state.lastReason = 'below_min_duration';
    state.rejectedSpeechMs = (state.rejectedSpeechMs || 0) + frameMs;
  } else if (!state.open && !candidate && !energetic) {
    state.lastReason = 'quiet';
  } else if (!state.open && !debounceOk && candidate) {
    state.lastReason = 'reopen_debounce';
    state.rejectedSpeechMs = (state.rejectedSpeechMs || 0) + frameMs;
  }

  if (state.open) {
    if (candidate) {
      state.hangoverMs = HANGOVER_MS;
      state.lastReason = aiSpeaking ? 'interruption_accepted' : 'caller_speech_accepted';
      if (aiSpeaking) {
        state.lastBargeAcceptAt = now;
      }
    } else {
      state.hangoverMs -= frameMs;
      if (state.hangoverMs <= 0) {
        state.open = false;
        state.speechMs = 0;
        state.closedMs = 0;
        state.lastReason = 'hangover_ended';
      } else {
        state.lastReason = 'hangover';
      }
    }
  }

  if (state.open) {
    state.forwardedFrames += 1;
    return {
      accept: true,
      reason: state.lastReason,
      speechMs: state.speechMs,
      open: true,
    };
  }

  state.droppedFrames += 1;
  return {
    accept: false,
    reason: state.lastReason || 'background_noise',
    speechMs: state.speechMs,
    open: false,
  };
}

/**
 * True when the gate has recently accepted sustained speech during AI playback.
 * Used to confirm Twilio clear on Gemini interrupt — does not mute PCM.
 * @param {ReturnType<typeof createSpeechGateState>} state
 * @param {{ nowMs?: number, confirmWindowMs?: number }} [opts]
 */
function isBargeInConfirmed(state, opts = {}) {
  if (!state) {
    return false;
  }
  const now =
    typeof opts.nowMs === 'number' && Number.isFinite(opts.nowMs)
      ? opts.nowMs
      : Date.now();
  const windowMs = Math.max(
    MIN_OPEN_MS_BARGE_IN,
    Number(opts.confirmWindowMs) || MIN_OPEN_MS_BARGE_IN * 4
  );
  const last = Number(state.lastBargeAcceptAt) || 0;
  if (last > 0 && now - last <= windowMs) {
    return true;
  }
  // Gate currently open with enough sustained speech counts as confirmed.
  if (state.open && state.speechMs >= MIN_OPEN_MS_BARGE_IN) {
    return true;
  }
  return false;
}

/**
 * Boolean wrapper for older callers / tests.
 * @param {Buffer} pcm16k
 * @param {ReturnType<typeof createSpeechGateState>} state
 * @param {{ aiSpeaking?: boolean, nowMs?: number }} [opts]
 * @returns {boolean}
 */
function shouldForward(pcm16k, state, opts = {}) {
  return evaluateFrame(pcm16k, state, opts).accept;
}

module.exports = {
  SAMPLE_RATE,
  FRAME_MS,
  HANGOVER_MS,
  OPEN_THRESHOLD_MS,
  MIN_OPEN_MS_IDLE,
  MIN_OPEN_MS_BARGE_IN,
  REOPEN_DEBOUNCE_MS,
  createSpeechGateState,
  evaluateFrame,
  shouldForward,
  isBargeInConfirmed,
  frameRms,
  zeroCrossingRate,
};
