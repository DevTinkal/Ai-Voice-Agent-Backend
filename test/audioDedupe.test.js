'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseLiveMessage } = require('../src/services/geminiLiveService');
const liveCallSession = require('../src/services/liveCallSession');
const { TWILIO_FRAME_BYTES } = require('../src/utils/audioCodec');

function makePcmBase64(sampleCount = 240) {
  const pcm = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    pcm.writeInt16LE((i % 50) * 100, i * 2);
  }
  return pcm.toString('base64');
}

describe('audio dedupe / single play', () => {
  it('parseLiveMessage extracts inlineData audio exactly once (ignores SDK data getter)', () => {
    const audioB64 = makePcmBase64(120);
    const message = {
      serverContent: {
        modelTurn: {
          parts: [
            {
              inlineData: {
                mimeType: 'audio/pcm;rate=24000',
                data: audioB64,
              },
            },
          ],
        },
      },
      // Simulate LiveServerMessage.data getter returning the same audio again.
      get data() {
        return audioB64;
      },
    };

    const parsed = parseLiveMessage(message);
    assert.equal(parsed.audioBuffers.length, 1);
    assert.equal(parsed.audioBuffers[0].toString('base64'), audioB64);
  });

  it('parseLiveMessage does not invent audio from message.data alone', () => {
    const parsed = parseLiveMessage({
      get data() {
        return makePcmBase64(40);
      },
    });
    assert.equal(parsed.audioBuffers.length, 0);
  });

  it('one Gemini PCM chunk produces monotonically increasing Twilio frame sends once', () => {
    const sent = [];
    const session = {
      callSid: 'CA_UNIT',
      streamSid: 'MZ_UNIT',
      waiting: false,
      playbackGeneration: 0,
      geminiChunkCount: 0,
      twilioFrameCount: 0,
      outboundRemainder: Buffer.alloc(0),
      twilioWs: {
        readyState: 1,
        send(raw) {
          const msg = JSON.parse(raw);
          if (msg.event === 'media') {
            sent.push(Buffer.from(msg.media.payload, 'base64'));
          }
        },
      },
    };

    // ~40ms @ 24kHz → after downsample ~40ms @ 8kHz ≈ 320 bytes → 2 frames
    const pcm = Buffer.alloc(960 * 2);
    liveCallSession.playGeminiPcmOnce(session, pcm, 0);
    liveCallSession.playGeminiPcmOnce(session, pcm, 0);

    assert.equal(session.geminiChunkCount, 2);
    assert.ok(sent.length >= 2);
    for (const frame of sent) {
      assert.equal(frame.length, TWILIO_FRAME_BYTES);
    }
    // Two identical source chunks must not collapse counters.
    assert.equal(session.twilioFrameCount, sent.length);
  });

  it('interrupt generation drops subsequent stale playback', () => {
    const sent = [];
    const session = {
      callSid: 'CA_INT',
      streamSid: 'MZ_INT',
      waiting: false,
      playbackGeneration: 0,
      geminiChunkCount: 0,
      twilioFrameCount: 0,
      outboundRemainder: Buffer.alloc(0),
      twilioWs: {
        readyState: 1,
        send(raw) {
          const msg = JSON.parse(raw);
          if (msg.event === 'media') sent.push(msg);
          if (msg.event === 'clear') sent.push(msg);
        },
      },
    };

    const pcm = Buffer.alloc(480 * 2);
    const gen0 = session.playbackGeneration;
    liveCallSession.clearTwilioPlayback(session);
    assert.equal(session.playbackGeneration, 1);
    liveCallSession.playGeminiPcmOnce(session, pcm, gen0); // stale
    assert.equal(session.geminiChunkCount, 0);
    liveCallSession.playGeminiPcmOnce(session, pcm, session.playbackGeneration);
    assert.equal(session.geminiChunkCount, 1);
    assert.ok(sent.some((m) => m.event === 'clear'));
  });

  it('startLiveCall is idempotent — second start does not create another Live connect', async () => {
    const existing = {
      callSid: 'CA_IDEMP',
      streamSid: 'MZ1',
      twilioWs: { readyState: 1 },
      liveSession: { close() {} },
      liveSessionEpoch: 1,
      greeted: true,
      connecting: false,
      ending: false,
    };
    liveCallSession.sessions.set('CA_IDEMP', existing);
    const result = await liveCallSession.startLiveCall({
      twilioWs: { readyState: 1 },
      callSid: 'CA_IDEMP',
      streamSid: 'MZ2',
    });
    assert.equal(result.liveSessionEpoch, 1);
    assert.equal(result.liveSession, existing.liveSession);
    liveCallSession.sessions.delete('CA_IDEMP');
  });
});
