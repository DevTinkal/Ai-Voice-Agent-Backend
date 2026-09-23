'use strict';

/** PCM16 mono @ 16 kHz: 16000 samples/s * 2 bytes = 32 bytes/ms. */
const PCM16K_BYTES_PER_MS = 32;

/**
 * @param {number} ms
 * @returns {number}
 */
function pcm16kBytesForDurationMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) {
    return 0;
  }
  return Math.floor(n * PCM16K_BYTES_PER_MS);
}

/**
 * @param {number} byteLength
 * @returns {number}
 */
function pcm16kDurationMs(byteLength) {
  return (Number(byteLength) || 0) / PCM16K_BYTES_PER_MS;
}

/**
 * @param {number} [batchMs]
 * @returns {object}
 */
function createPcmBatchState(batchMs = 0) {
  const ms = Math.floor(Number(batchMs) || 0);
  return {
    batchMs: ms > 0 ? ms : 0,
    chunks: [],
    pendingBytes: 0,
    flushTimer: null,
    inputBytes: 0,
    sentBytes: 0,
    batchCount: 0,
    flushCount: 0,
    droppedBytes: 0,
    droppedFrames: 0,
  };
}

/**
 * @param {object} state
 * @param {{ send: (buf: Buffer) => void, scheduleFlush?: (ms: number, fn: () => void) => any, clearFlush?: (timer: any) => void }} hooks
 * @param {string} [reason]
 * @returns {number} bytes flushed
 */
function flushPcmBatch(state, hooks, reason = 'flush') {
  if (!state) {
    return 0;
  }
  if (state.flushTimer != null && hooks && typeof hooks.clearFlush === 'function') {
    hooks.clearFlush(state.flushTimer);
    state.flushTimer = null;
  }
  if (!state.chunks || !state.chunks.length) {
    state.pendingBytes = 0;
    return 0;
  }
  const combined = Buffer.concat(state.chunks);
  state.chunks = [];
  state.pendingBytes = 0;
  if (
    reason === 'timer' ||
    reason === 'end' ||
    reason === 'reconnect' ||
    reason === 'wait_stream_end'
  ) {
    state.flushCount += 1;
  }
  if (!combined.length) {
    return 0;
  }
  try {
    hooks.send(combined);
    state.sentBytes += combined.length;
    state.batchCount += 1;
  } catch {
    state.droppedBytes += combined.length;
    state.droppedFrames += 1;
  }
  return combined.length;
}

/**
 * Push one PCM16k chunk. When batchMs=0, sends immediately.
 * Never reorders, duplicates, or silently drops on the happy path.
 *
 * @param {object} state
 * @param {Buffer} pcm
 * @param {{ send: (buf: Buffer) => void, scheduleFlush?: (ms: number, fn: () => void) => any, clearFlush?: (timer: any) => void }} hooks
 * @returns {'noop'|'immediate'|'queued'|'flushed'}
 */
function pushPcmBatch(state, pcm, hooks) {
  if (!state || !pcm || !pcm.length) {
    return 'noop';
  }
  state.inputBytes += pcm.length;

  if (!state.batchMs) {
    try {
      hooks.send(pcm);
      state.sentBytes += pcm.length;
      state.batchCount += 1;
    } catch {
      state.droppedBytes += pcm.length;
      state.droppedFrames += 1;
    }
    return 'immediate';
  }

  state.chunks.push(pcm);
  state.pendingBytes += pcm.length;

  const target = pcm16kBytesForDurationMs(state.batchMs);
  if (state.pendingBytes >= target) {
    flushPcmBatch(state, hooks, 'size');
    return 'flushed';
  }

  if (state.flushTimer == null && hooks && typeof hooks.scheduleFlush === 'function') {
    state.flushTimer = hooks.scheduleFlush(state.batchMs, () => {
      state.flushTimer = null;
      flushPcmBatch(state, hooks, 'timer');
    });
  }
  return 'queued';
}

/**
 * Snapshot for [AUDIO_BATCH_HEALTH] (no payloads).
 * @param {object} state
 */
function summarizePcmBatch(state) {
  const inputBytes = (state && state.inputBytes) || 0;
  const sentBytes = (state && state.sentBytes) || 0;
  const pendingBytes = (state && state.pendingBytes) || 0;
  const inputMs = Math.round(pcm16kDurationMs(inputBytes));
  const sentMs = Math.round(pcm16kDurationMs(sentBytes));
  const ratio =
    inputMs > 0 ? Math.round((sentMs / inputMs) * 1000) / 1000 : 0;
  return {
    mode: (state && state.batchMs) || 0,
    inputBytes,
    sentBytes,
    pendingBytes,
    inputMs,
    sentMs,
    batches: (state && state.batchCount) || 0,
    flushCount: (state && state.flushCount) || 0,
    droppedBytes: (state && state.droppedBytes) || 0,
    droppedFrames: (state && state.droppedFrames) || 0,
    ratio,
  };
}

module.exports = {
  PCM16K_BYTES_PER_MS,
  pcm16kBytesForDurationMs,
  pcm16kDurationMs,
  createPcmBatchState,
  pushPcmBatch,
  flushPcmBatch,
  summarizePcmBatch,
};
