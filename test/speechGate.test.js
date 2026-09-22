'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createSpeechGateState,
  evaluateFrame,
  shouldForward,
  HANGOVER_MS,
  MIN_OPEN_MS_IDLE,
  MIN_OPEN_MS_BARGE_IN,
} = require('../src/utils/speechGate');

function makeSilencePcm16k(samples = 320) {
  return Buffer.alloc(samples * 2);
}

function makeNoiseBurstPcm16k(samples = 320) {
  const buf = Buffer.alloc(samples * 2);
  buf.writeInt16LE(20000, 0);
  return buf;
}

function makeSpeechLikePcm16k(samples = 320, amplitude = 3500) {
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const t = i / 16000;
    const sample = Math.round(
      amplitude *
        (0.6 * Math.sin(2 * Math.PI * 220 * t) +
          0.3 * Math.sin(2 * Math.PI * 440 * t) +
          0.2 * Math.sin(2 * Math.PI * 880 * t))
    );
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

describe('speechGate evaluateFrame', () => {
  it('rejects quiet / low RMS frames', () => {
    const state = createSpeechGateState();
    for (let i = 0; i < 20; i += 1) {
      const d = evaluateFrame(makeSilencePcm16k(), state);
      assert.equal(d.accept, false);
    }
    assert.equal(state.open, false);
  });

  it('rejects short speech-like spike below minOpenMs', () => {
    const state = createSpeechGateState();
    // One 20ms frame — below MIN_OPEN_MS_IDLE (150)
    const d = evaluateFrame(makeSpeechLikePcm16k(), state);
    assert.equal(d.accept, false);
    assert.ok(
      d.reason === 'below_min_duration' || d.reason === 'reopen_debounce'
    );
    assert.ok(MIN_OPEN_MS_IDLE >= 120);
  });

  it('accepts sustained speech-like frames after minOpenMs idle', () => {
    const state = createSpeechGateState();
    let accepted = 0;
    // 20ms * 10 = 200ms > 150ms idle threshold
    for (let i = 0; i < 12; i += 1) {
      if (evaluateFrame(makeSpeechLikePcm16k(), state).accept) accepted += 1;
    }
    assert.ok(accepted >= 1);
    assert.equal(state.open, true);
  });

  it('opens sooner when aiSpeaking (barge-in path)', () => {
    const idle = createSpeechGateState();
    const barge = createSpeechGateState();
    // ~120ms of speech (6 x 20ms) — at barge 120ms, still below idle 150ms
    for (let i = 0; i < 6; i += 1) {
      evaluateFrame(makeSpeechLikePcm16k(), idle, { aiSpeaking: false });
      evaluateFrame(makeSpeechLikePcm16k(), barge, { aiSpeaking: true });
    }
    assert.equal(idle.open, false);
    assert.equal(barge.open, true);
    assert.ok(MIN_OPEN_MS_BARGE_IN < MIN_OPEN_MS_IDLE);
    assert.equal(MIN_OPEN_MS_BARGE_IN, 120);
    assert.equal(
      evaluateFrame(makeSpeechLikePcm16k(), barge, { aiSpeaking: true }).reason,
      'interruption_accepted'
    );
  });

  it('keeps hangover open after speech ends (no abrupt cutoff)', () => {
    const state = createSpeechGateState();
    for (let i = 0; i < 12; i += 1) {
      shouldForward(makeSpeechLikePcm16k(), state);
    }
    assert.equal(state.open, true);
    assert.ok(HANGOVER_MS >= 450);

    let hangoverPass = 0;
    for (let i = 0; i < 18; i += 1) {
      if (shouldForward(makeSilencePcm16k(320), state)) hangoverPass += 1;
    }
    assert.ok(hangoverPass >= 15);
    assert.equal(state.open, true);
  });

  it('does not open on single-sample noise spike', () => {
    const state = createSpeechGateState();
    assert.equal(shouldForward(makeNoiseBurstPcm16k(), state), false);
    assert.equal(shouldForward(makeSilencePcm16k(), state), false);
  });
});
