'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createSpeechGateState,
  shouldForward,
  HANGOVER_MS,
} = require('../src/utils/speechGate');
const {
  buildLiveConfig,
  buildRealtimeInputConfig,
} = require('../src/services/geminiLiveService');
const geminiLiveService = require('../src/services/geminiLiveService');
const {
  ActivityHandling,
  StartSensitivity,
  EndSensitivity,
} = require('@google/genai');
const liveCallSession = require('../src/services/liveCallSession');

function makeNoiseBurstPcm16k(samples = 320) {
  const buf = Buffer.alloc(samples * 2);
  // Single-sample spike then silence — should not open the gate alone.
  buf.writeInt16LE(20000, 0);
  return buf;
}

function makeSilencePcm16k(samples = 320) {
  return Buffer.alloc(samples * 2);
}

function makeSpeechLikePcm16k(samples = 320, amplitude = 3500) {
  // Mix of harmonics → moderate ZCR in speech-like band.
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

describe('speechGate', () => {
  it('labels sustained silence as non-speech', () => {
    const state = createSpeechGateState();
    let labeledSpeech = 0;
    for (let i = 0; i < 20; i += 1) {
      if (shouldForward(makeSilencePcm16k(), state)) labeledSpeech += 1;
    }
    assert.equal(labeledSpeech, 0);
  });

  it('does not open on short noise spike', () => {
    const state = createSpeechGateState();
    assert.equal(shouldForward(makeNoiseBurstPcm16k(), state), false);
    assert.equal(shouldForward(makeSilencePcm16k(), state), false);
  });

  it('labels sustained speech-like energy as speech', () => {
    const state = createSpeechGateState();
    let labeledSpeech = 0;
    for (let i = 0; i < 12; i += 1) {
      if (shouldForward(makeSpeechLikePcm16k(), state)) labeledSpeech += 1;
    }
    assert.ok(labeledSpeech >= 1);
    assert.equal(state.open, true);
  });

  it('keeps speech label open through hangover longer than VAD silence (300ms)', () => {
    const state = createSpeechGateState();
    for (let i = 0; i < 10; i += 1) {
      shouldForward(makeSpeechLikePcm16k(), state);
    }
    assert.equal(state.open, true);
    assert.ok(HANGOVER_MS >= 450);

    // 320 samples @ 16k = 20ms. 18 quiet frames ≈ 360ms — still within 450ms hangover.
    let hangoverPass = 0;
    for (let i = 0; i < 18; i += 1) {
      if (shouldForward(makeSilencePcm16k(320), state)) hangoverPass += 1;
    }
    assert.ok(hangoverPass >= 15);
    assert.equal(state.open, true);
  });
});

describe('forwardTwilioMedia always streams PCM', () => {
  it('sends silence frames to Gemini even when gate labels non-speech', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(pcm);
    };

    try {
      const session = {
        callSid: 'CA_GATE_PASS',
        liveSession: { mock: true },
        forwardAudio: true,
        waiting: false,
        inboundMediaCount: 0,
        gatedDropCount: 0,
        speechLabeledCount: 0,
        geminiInCount: 0,
        speechGate: createSpeechGateState(),
      };

      // μ-law silence frame (20ms @ 8k) — gate will label non-speech.
      const silenceMulawB64 = Buffer.alloc(160, 0xff).toString('base64');
      for (let i = 0; i < 5; i += 1) {
        liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      }

      assert.equal(sent.length, 5);
      assert.equal(session.geminiInCount, 5);
      assert.equal(session.inboundMediaCount, 5);
      assert.ok(session.gatedDropCount >= 1);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });
});

describe('Gemini Live VAD config', () => {
  it('buildRealtimeInputConfig uses verified SDK enums', () => {
    const cfg = buildRealtimeInputConfig();
    assert.equal(
      cfg.activityHandling,
      ActivityHandling.START_OF_ACTIVITY_INTERRUPTS
    );
    assert.equal(cfg.automaticActivityDetection.disabled, false);
    assert.ok(
      Object.values(StartSensitivity).includes(
        cfg.automaticActivityDetection.startOfSpeechSensitivity
      )
    );
    assert.ok(
      Object.values(EndSensitivity).includes(
        cfg.automaticActivityDetection.endOfSpeechSensitivity
      )
    );
    assert.equal(
      cfg.automaticActivityDetection.endOfSpeechSensitivity,
      EndSensitivity.END_SENSITIVITY_HIGH
    );
    assert.equal(cfg.automaticActivityDetection.prefixPaddingMs, 100);
    assert.equal(cfg.automaticActivityDetection.silenceDurationMs, 300);
  });

  it('buildLiveConfig includes realtimeInputConfig', () => {
    const live = buildLiveConfig({
      midCall: false,
      systemInstruction: 'You are a test voice agent.',
    });
    assert.ok(live.realtimeInputConfig);
    assert.ok(live.realtimeInputConfig.automaticActivityDetection);
    assert.match(String(live.systemInstruction), /test voice agent/);
    assert.doesNotMatch(String(live.systemInstruction), /Parker|JPLoft/i);
  });

  it('buildLiveConfig enables context compression and session resumption', () => {
    const fresh = buildLiveConfig({
      midCall: false,
      systemInstruction: 'Base prompt A.',
    });
    assert.ok(fresh.contextWindowCompression);
    assert.ok(fresh.contextWindowCompression.slidingWindow);
    assert.ok(fresh.sessionResumption);
    assert.equal(fresh.sessionResumption.handle, undefined);

    const resumed = buildLiveConfig({
      midCall: true,
      systemInstruction: 'Base prompt B.',
      sessionResumptionHandle: 'handle-abc',
    });
    assert.equal(resumed.sessionResumption.handle, 'handle-abc');
    assert.ok(resumed.contextWindowCompression.slidingWindow);
  });

  it('buildLiveConfig rejects missing systemInstruction', () => {
    assert.throws(
      () => buildLiveConfig({ midCall: false }),
      /systemInstruction is required/
    );
  });
});

describe('interrupt stale audio', () => {
  it('interrupted path clears and suppresses stale generation audio', () => {
    const sent = [];
    const session = {
      callSid: 'CA_BARGE',
      streamSid: 'MZ_BARGE',
      waiting: false,
      ending: false,
      liveSessionEpoch: 1,
      playbackGeneration: 0,
      geminiChunkCount: 0,
      twilioFrameCount: 0,
      outboundRemainder: Buffer.alloc(0),
      suppressStaleOutput: false,
      aiSpeaking: true,
      turnFirstAudioLogged: true,
      t0: Date.now(),
      twilioWs: {
        readyState: 1,
        send(raw) {
          sent.push(JSON.parse(raw));
        },
      },
    };

    const genBefore = session.playbackGeneration;
    liveCallSession.handleLiveMessage(
      session,
      {
        serverContent: {
          interrupted: true,
          modelTurn: {
            parts: [
              {
                inlineData: {
                  mimeType: 'audio/pcm;rate=24000',
                  data: Buffer.alloc(480 * 2).toString('base64'),
                },
              },
            ],
          },
        },
      },
      1
    );

    assert.ok(session.playbackGeneration > genBefore);
    assert.equal(session.suppressStaleOutput, true);
    assert.equal(session.aiSpeaking, false);
    assert.ok(sent.some((m) => m.event === 'clear'));
    // Interrupted message audio must not be played.
    assert.equal(session.geminiChunkCount, 0);

    // Stale generation rejected.
    liveCallSession.playGeminiPcmOnce(session, Buffer.alloc(480 * 2), genBefore);
    assert.equal(session.geminiChunkCount, 0);

    // Fresh generation after clear is allowed.
    liveCallSession.playGeminiPcmOnce(
      session,
      Buffer.alloc(480 * 2),
      session.playbackGeneration
    );
    assert.equal(session.geminiChunkCount, 1);
    assert.equal(session.suppressStaleOutput, false);
  });
});
