'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  mulawToPcm16,
  pcm16ToMulaw,
  mulaw8kToPcm16k,
  pcm24kToMulaw8k,
  chunkMulawForTwilio,
  upsamplePcm16,
  TWILIO_FRAME_BYTES,
} = require('../src/utils/audioCodec');

describe('audioCodec', () => {
  it('round-trips silence mulaw <-> pcm', () => {
    const mulaw = Buffer.alloc(160, 0xff);
    const pcm = mulawToPcm16(mulaw);
    assert.equal(pcm.length, 320);
    const back = pcm16ToMulaw(pcm);
    assert.equal(back.length, 160);
  });

  it('upsamples 8k mulaw to 16k pcm without 2x last-sample duplication bug', () => {
    const mulaw = Buffer.alloc(80, 0xff);
    const pcm16k = mulaw8kToPcm16k(mulaw);
    // 80 samples @8k → upsample to (80-1)*2+1 = 159 samples when using fixed upsample
    // via mulaw8kToPcm16k path: 80 pcm samples → upsample
    assert.ok(pcm16k.length >= 158 * 2 && pcm16k.length <= 160 * 2);
  });

  it('upsample factor 2 produces (n-1)*2+1 samples', () => {
    const pcm = Buffer.alloc(10 * 2);
    for (let i = 0; i < 10; i += 1) pcm.writeInt16LE(i * 100, i * 2);
    const up = upsamplePcm16(pcm, 2);
    assert.equal(up.length / 2, (10 - 1) * 2 + 1);
  });

  it('downsamples 24k pcm to 8k mulaw without expanding duration', () => {
    // 30ms @ 24k = 720 samples
    const pcm24k = Buffer.alloc(720 * 2);
    const mulaw = pcm24kToMulaw8k(pcm24k);
    // 30ms @ 8k ≈ 240 samples
    assert.ok(mulaw.length >= 230 && mulaw.length <= 250);
  });

  it('chunks mulaw into exact 160-byte frames with remainder carry', () => {
    const { frames, remainder } = chunkMulawForTwilio(Buffer.alloc(400, 0xff));
    assert.equal(frames.length, 2);
    assert.equal(frames[0].length, TWILIO_FRAME_BYTES);
    assert.equal(frames[1].length, TWILIO_FRAME_BYTES);
    assert.equal(remainder.length, 80);

    const next = chunkMulawForTwilio(Buffer.alloc(80, 0xaa), TWILIO_FRAME_BYTES, remainder);
    assert.equal(next.frames.length, 1);
    assert.equal(next.frames[0].length, 160);
    assert.equal(next.remainder.length, 0);
  });

  it('frame buffers are copies not shared views', () => {
    const src = Buffer.alloc(160, 0x11);
    const { frames } = chunkMulawForTwilio(src);
    src.fill(0x22);
    assert.equal(frames[0][0], 0x11);
  });

  it('mulaw8k→pcm16k preserves wall-clock duration (~1.0 ratio)', () => {
    // 100 frames × 20ms = 2000ms @ 8k (160 bytes/frame)
    const frames = 100;
    const mulaw = Buffer.alloc(frames * 160, 0xff);
    const twilioMs = (mulaw.length / 8000) * 1000;
    const pcm16k = mulaw8kToPcm16k(mulaw);
    const geminiMs = (pcm16k.length / 2 / 16000) * 1000;
    const ratio = geminiMs / twilioMs;
    assert.ok(
      ratio >= 0.95 && ratio <= 1.05,
      `duration ratio ${ratio} outside 0.95–1.05 (twilioMs=${twilioMs} geminiMs=${geminiMs})`
    );
    // PCM16 is 2 bytes/sample; ~2x sample rate → roughly 4x byte size, not collapsed
    assert.ok(pcm16k.length > mulaw.length * 2);
    assert.ok(pcm16k.length < mulaw.length * 5);
  });

  it('single 20ms Twilio frame converts without collapsing duration', () => {
    const mulaw = Buffer.alloc(160, 0xff); // 20ms @ 8k
    const pcm16k = mulaw8kToPcm16k(mulaw);
    const pcmSamples = pcm16k.length / 2;
    // Upsample (n-1)*2+1 → 319 samples ≈ 19.9ms @ 16k
    assert.ok(pcmSamples >= 300 && pcmSamples <= 320);
  });
});
