'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  pcm16kBytesForDurationMs,
  pcm16kDurationMs,
  createPcmBatchState,
  pushPcmBatch,
  flushPcmBatch,
  summarizePcmBatch,
  PCM16K_BYTES_PER_MS,
} = require('../src/utils/pcmBatcher');
const { mulaw8kToPcm16k } = require('../src/utils/audioCodec');
const { createSpeechGateState } = require('../src/utils/speechGate');
const geminiLiveService = require('../src/services/geminiLiveService');
const liveCallSession = require('../src/services/liveCallSession');

describe('pcmBatcher math', () => {
  it('100 ms at 16k PCM16 mono is 3200 bytes', () => {
    assert.equal(PCM16K_BYTES_PER_MS, 32);
    assert.equal(pcm16kBytesForDurationMs(100), 3200);
    assert.equal(pcm16kDurationMs(3200), 100);
  });

  it('mode 0 sends immediately without buffering', () => {
    const sent = [];
    const state = createPcmBatchState(0);
    const a = Buffer.alloc(640, 1);
    const b = Buffer.alloc(640, 2);
    assert.equal(pushPcmBatch(state, a, { send: (buf) => sent.push(Buffer.from(buf)) }), 'immediate');
    assert.equal(pushPcmBatch(state, b, { send: (buf) => sent.push(Buffer.from(buf)) }), 'immediate');
    assert.equal(sent.length, 2);
    assert.ok(sent[0].equals(a));
    assert.ok(sent[1].equals(b));
    assert.equal(state.batchCount, 2);
    assert.equal(state.inputBytes, 1280);
    assert.equal(state.sentBytes, 1280);
    assert.equal(state.chunks.length, 0);
  });

  it('mode 100 groups into ~100 ms chunks preserving order and bytes', () => {
    const sent = [];
    const timers = [];
    const state = createPcmBatchState(100);
    const hooks = {
      send(buf) {
        sent.push(Buffer.from(buf));
      },
      scheduleFlush(ms, fn) {
        const id = { ms, fn };
        timers.push(id);
        return id;
      },
      clearFlush() {},
    };
    // Five 20 ms frames = 100 ms @ 32 bytes/ms
    const frames = [];
    for (let i = 0; i < 5; i += 1) {
      const frame = Buffer.alloc(640, i + 1);
      frames.push(frame);
      pushPcmBatch(state, frame, hooks);
    }
    assert.equal(sent.length, 1);
    assert.equal(sent[0].length, 3200);
    assert.ok(sent[0].equals(Buffer.concat(frames)));
    assert.equal(state.inputBytes, 3200);
    assert.equal(state.sentBytes, 3200);
    assert.equal(state.batchCount, 1);
    assert.equal(state.droppedBytes, 0);
    const summary = summarizePcmBatch(state);
    assert.equal(summary.mode, 100);
    assert.equal(summary.inputMs, 100);
    assert.equal(summary.sentMs, 100);
    assert.equal(summary.ratio, 1);
  });

  it('does not drop or duplicate across multiple batches', () => {
    const sent = [];
    const state = createPcmBatchState(100);
    const hooks = { send: (buf) => sent.push(Buffer.from(buf)) };
    const all = [];
    for (let i = 0; i < 10; i += 1) {
      const frame = Buffer.alloc(640, i + 10);
      all.push(frame);
      pushPcmBatch(state, frame, hooks);
    }
    assert.equal(sent.length, 2);
    assert.ok(Buffer.concat(sent).equals(Buffer.concat(all)));
    assert.equal(state.inputBytes, state.sentBytes);
    assert.equal(state.droppedBytes, 0);
  });

  it('timer flush sends partial batch without audioStreamEnd semantics', () => {
    const sent = [];
    let flushFn = null;
    const state = createPcmBatchState(100);
    const hooks = {
      send(buf) {
        sent.push(Buffer.from(buf));
      },
      scheduleFlush(_ms, fn) {
        flushFn = fn;
        return 'timer';
      },
      clearFlush() {},
    };
    const partial = Buffer.alloc(640, 7);
    assert.equal(pushPcmBatch(state, partial, hooks), 'queued');
    assert.equal(sent.length, 0);
    assert.ok(flushFn);
    flushFn();
    assert.equal(sent.length, 1);
    assert.ok(sent[0].equals(partial));
    assert.equal(state.flushCount, 1);
    assert.equal(state.sentBytes, 640);
  });

  it('stream-end flush drains remaining partial batch', () => {
    const sent = [];
    const state = createPcmBatchState(100);
    const hooks = {
      send(buf) {
        sent.push(Buffer.from(buf));
      },
      scheduleFlush() {
        return 't';
      },
      clearFlush() {},
    };
    pushPcmBatch(state, Buffer.alloc(640, 3), hooks);
    assert.equal(sent.length, 0);
    flushPcmBatch(state, hooks, 'end');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].length, 640);
    assert.equal(state.flushCount, 1);
    assert.equal(state.pendingBytes, 0);
  });

  it('send failure counts dropped bytes without claiming sent', () => {
    const state = createPcmBatchState(0);
    pushPcmBatch(state, Buffer.alloc(100, 1), {
      send() {
        throw new Error('no_live_session');
      },
    });
    assert.equal(state.sentBytes, 0);
    assert.equal(state.droppedBytes, 100);
    assert.equal(state.droppedFrames, 1);
  });
});

describe('forwardTwilioMedia optional PCM batching', () => {
  const silenceMulawB64 = Buffer.alloc(160, 0xff).toString('base64');

  function makeSession(pcmBatchMs) {
    return {
      callSid: 'CA_PCM_BATCH',
      liveSession: { mock: true },
      forwardAudio: true,
      waiting: false,
      aiSpeaking: false,
      inboundMediaCount: 0,
      inboundMulawBytes: 0,
      geminiInCount: 0,
      geminiPcmBytes: 0,
      gatedDropCount: 0,
      speechLabeledCount: 0,
      speechGate: createSpeechGateState(),
      pcmBatch: createPcmBatchState(pcmBatchMs),
    };
  }

  it('GEMINI_PCM_BATCH_MS=0 preserves immediate-send behavior', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };
    try {
      const session = makeSession(0);
      const expectedPcm = mulaw8kToPcm16k(Buffer.from(silenceMulawB64, 'base64'));
      for (let i = 0; i < 5; i += 1) {
        liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      }
      assert.equal(sent.length, 5);
      for (const pcm of sent) {
        assert.ok(pcm.equals(expectedPcm));
      }
      const summary = summarizePcmBatch(session.pcmBatch);
      assert.equal(summary.mode, 0);
      assert.equal(summary.batches, 5);
      assert.equal(summary.inputBytes, summary.sentBytes);
      assert.equal(summary.droppedBytes, 0);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('GEMINI_PCM_BATCH_MS=100 groups frames into ~100 ms sends', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };
    try {
      const session = makeSession(100);
      const expectedPcm = mulaw8kToPcm16k(Buffer.from(silenceMulawB64, 'base64'));
      for (let i = 0; i < 5; i += 1) {
        liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      }
      // Upsample length may be slightly under 640; need enough frames to hit 3200.
      // Keep forwarding until at least one batch flushed.
      let guard = 0;
      while (sent.length === 0 && guard < 20) {
        liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
        guard += 1;
      }
      assert.ok(sent.length >= 1);
      assert.ok(sent[0].length >= pcm16kBytesForDurationMs(100) - expectedPcm.length);
      // All sent bytes concatenated equal all input accepted into batcher.
      assert.equal(session.pcmBatch.inputBytes, session.pcmBatch.sentBytes + session.pcmBatch.pendingBytes);
      liveCallSession.flushCallerPcmBatch(session, 'end');
      assert.equal(session.pcmBatch.inputBytes, session.pcmBatch.sentBytes);
      assert.equal(session.pcmBatch.droppedBytes, 0);
      assert.ok(session.pcmBatch.batchCount >= 1);
      assert.ok(sent.every((chunk) => chunk.length > expectedPcm.length || sent.length === 1));
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('total input PCM duration equals total sent after end flush', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };
    try {
      const session = makeSession(100);
      for (let i = 0; i < 7; i += 1) {
        liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      }
      liveCallSession.flushCallerPcmBatch(session, 'end');
      const summary = summarizePcmBatch(session.pcmBatch);
      assert.equal(summary.inputBytes, summary.sentBytes);
      assert.equal(summary.droppedBytes, 0);
      assert.equal(summary.ratio, 1);
      assert.ok(Buffer.concat(sent).length === summary.sentBytes);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('WAIT=true still buffers/sends caller PCM to Gemini', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };
    try {
      const session = makeSession(0);
      session.waiting = true;
      liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      assert.equal(sent.length, 1);
      assert.equal(session.waiting, true);
      assert.equal(session.pcmBatch.sentBytes, sent[0].length);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('WAIT=true with batching still reaches Gemini after flush', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };
    try {
      const session = makeSession(100);
      session.waiting = true;
      liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      assert.equal(session.waiting, true);
      assert.ok(session.pcmBatch.inputBytes > 0);
      liveCallSession.flushCallerPcmBatch(session, 'end');
      assert.equal(sent.length, 1);
      assert.equal(session.pcmBatch.droppedBytes, 0);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('speechGate noise labels do not drop PCM under batching', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };
    try {
      const session = makeSession(100);
      for (let i = 0; i < 8; i += 1) {
        liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      }
      liveCallSession.flushCallerPcmBatch(session, 'end');
      assert.ok(session.gatedDropCount >= 1);
      assert.equal(session.pcmBatch.droppedBytes, 0);
      assert.equal(session.pcmBatch.inputBytes, session.pcmBatch.sentBytes);
      assert.ok(sent.length >= 1);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('barge-in playback clear does not discard next caller frames', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };
    try {
      const session = makeSession(0);
      session.suppressStaleOutput = true;
      session.playbackGeneration = 2;
      session.streamSid = 'MZ_BATCH';
      session.twilioWs = { readyState: 1, send() {} };
      session.outboundRemainder = Buffer.alloc(0);
      liveCallSession.clearTwilioPlayback(session);
      liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      assert.equal(sent.length, 1);
      assert.equal(session.pcmBatch.droppedBytes, 0);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('no second STT and no company phonetic maps in batcher/live sources', () => {
    const batcherSrc = fs.readFileSync(
      path.join(__dirname, '../src/utils/pcmBatcher.js'),
      'utf8'
    );
    const liveSrc = fs.readFileSync(
      path.join(__dirname, '../src/services/liveCallSession.js'),
      'utf8'
    );
    assert.doesNotMatch(batcherSrc, /deepgram|conversationrelay|transcribe-live|Josid|ZUSIT/i);
    assert.doesNotMatch(liveSrc, /Josid|ZUSIT|Joshit/);
    assert.match(liveSrc, /AUDIO_BATCH_HEALTH/);
    assert.match(liveSrc, /GEMINI_PCM_BATCH_MS|geminiPcmBatchMs|pcmBatch/);
  });

  it('default env geminiPcmBatchMs is 0', () => {
    const { env } = require('../src/config/env');
    assert.equal(env.geminiPcmBatchMs, 0);
  });
});
