'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createSpeechGateState,
  shouldForward,
  evaluateFrame,
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
const { mulaw8kToPcm16k, pcm16ToMulaw, resamplePcm16 } = require('../src/utils/audioCodec');

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

describe('forwardTwilioMedia always forwards real PCM', () => {
  it('sends decoded PCM even when gate labels non-speech (metrics-only gate)', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };

    try {
      const session = {
        callSid: 'CA_GATE_PASS',
        liveSession: { mock: true },
        forwardAudio: true,
        waiting: false,
        aiSpeaking: false,
        inboundMediaCount: 0,
        gatedDropCount: 0,
        speechLabeledCount: 0,
        geminiInCount: 0,
        speechGate: createSpeechGateState(),
      };

      // μ-law silence frame (20ms @ 8k) — gate will label as non-speech.
      const silenceMulawB64 = Buffer.alloc(160, 0xff).toString('base64');
      const expectedPcm = mulaw8kToPcm16k(Buffer.from(silenceMulawB64, 'base64'));
      for (let i = 0; i < 5; i += 1) {
        liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      }

      assert.equal(sent.length, 5);
      assert.equal(session.geminiInCount, 5);
      assert.equal(session.inboundMediaCount, 5);
      assert.ok(session.gatedDropCount >= 1);
      // Must forward real PCM — not silence-replaced zeros.
      for (const pcm of sent) {
        assert.equal(pcm.length, expectedPcm.length);
        assert.ok(pcm.equals(expectedPcm));
      }
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('forwards real PCM while waiting=true (no mute deadlock)', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };
    try {
      const session = {
        callSid: 'CA_WAIT_PCM',
        liveSession: { mock: true },
        forwardAudio: true,
        waiting: true,
        aiSpeaking: false,
        inboundMediaCount: 0,
        gatedDropCount: 0,
        speechLabeledCount: 0,
        geminiInCount: 0,
        speechGate: createSpeechGateState(),
      };
      const silenceMulawB64 = Buffer.alloc(160, 0xff).toString('base64');
      const expectedPcm = mulaw8kToPcm16k(Buffer.from(silenceMulawB64, 'base64'));
      liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      assert.equal(sent.length, 1);
      assert.ok(sent[0].equals(expectedPcm));
      assert.equal(session.forwardAudio, true);
      // Quiet frame while waiting must not clear wait (speech gate did not accept).
      assert.equal(session.waiting, true);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('forwards PCM after barge-in clear while waiting remains false', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };
    try {
      const session = {
        callSid: 'CA_BARGE_FWD',
        liveSession: { mock: true },
        forwardAudio: true,
        waiting: false,
        aiSpeaking: false,
        suppressStaleOutput: true,
        playbackGeneration: 3,
        inboundMediaCount: 0,
        inboundMulawBytes: 0,
        geminiInCount: 0,
        geminiPcmBytes: 0,
        gatedDropCount: 0,
        speechLabeledCount: 0,
        speechGate: createSpeechGateState(),
        streamSid: 'MZ_FWD',
        twilioWs: { readyState: 1, send() {} },
        outboundRemainder: Buffer.alloc(0),
      };
      liveCallSession.clearTwilioPlayback(session);
      const silenceMulawB64 = Buffer.alloc(160, 0xff).toString('base64');
      liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      assert.equal(sent.length, 1);
      assert.equal(session.geminiInCount, 1);
      assert.ok(session.geminiPcmBytes > 0);
      assert.ok(session.inboundMulawBytes > 0);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('AUDIO_PATH_HEALTH ratio near 1.0 when frames are forwarded', () => {
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = () => {};
    try {
      const session = {
        callSid: 'CA_PATH_HEALTH',
        liveSession: { mock: true },
        forwardAudio: true,
        waiting: false,
        aiSpeaking: false,
        inboundMediaCount: 0,
        inboundMulawBytes: 0,
        geminiInCount: 0,
        geminiPcmBytes: 0,
        audioForwardSkipped: 0,
        gatedDropCount: 0,
        speechLabeledCount: 0,
        speechGate: createSpeechGateState(),
      };
      const silenceMulawB64 = Buffer.alloc(160, 0xff).toString('base64');
      for (let i = 0; i < 50; i += 1) {
        liveCallSession.forwardTwilioMedia(session, silenceMulawB64);
      }
      const health = liveCallSession.computeAudioPathHealth(session);
      assert.equal(health.inboundFrames, 50);
      assert.equal(health.geminiFrames, 50);
      assert.equal(health.skipped, 0);
      assert.equal(health.classification, 'ok');
      assert.ok(health.ratio >= 0.95 && health.ratio <= 1.05);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('does not invent company phonetic corrections in liveCallSession source', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/liveCallSession.js'),
      'utf8'
    );
    assert.doesNotMatch(src, /Josid|ZUSIT|Joshit|Juiced\s*Fuel/i);
    assert.match(src, /AUDIO_PATH_HEALTH/);
  });
});

describe('wait-hold recovery', () => {
  it('wait hold keeps forwardAudio true and sets waiting', async () => {
    const session = {
      callSid: 'CA_WAIT_HOLD',
      liveSession: {
        sendRealtimeInput() {},
      },
      waiting: false,
      forwardAudio: true,
      history: [],
      streamSid: 'MZ1',
      twilioWs: { readyState: 1, send() {} },
      playbackGeneration: 0,
      outboundRemainder: Buffer.alloc(0),
    };
    await liveCallSession.onCallerUtterance(session, 'wait wait');
    assert.equal(session.waiting, true);
    assert.equal(session.forwardAudio, true);
  });

  it('speechGate accept after wait does NOT clear waiting', () => {
    const sent = [];
    const original = geminiLiveService.sendPcm16kAudio;
    geminiLiveService.sendPcm16kAudio = (_live, pcm) => {
      sent.push(Buffer.from(pcm));
    };
    try {
      const session = {
        callSid: 'CA_WAIT_RECOVER',
        liveSession: { mock: true },
        forwardAudio: true,
        waiting: true,
        aiSpeaking: false,
        inboundMediaCount: 0,
        gatedDropCount: 0,
        speechLabeledCount: 0,
        geminiInCount: 0,
        speechGate: createSpeechGateState(),
      };
      // Sustained speech-like frames must keep PCM flowing but not end WAIT.
      const speech16k = makeSpeechLikePcm16k(3200, 4000);
      const speech8k = resamplePcm16(speech16k, 16000, 8000);
      const mulaw = pcm16ToMulaw(speech8k);
      const frameBytes = 160;
      for (let offset = 0; offset + frameBytes <= mulaw.length; offset += frameBytes) {
        const b64 = mulaw.subarray(offset, offset + frameBytes).toString('base64');
        liveCallSession.forwardTwilioMedia(session, b64);
      }
      assert.ok(sent.length > 0);
      assert.equal(session.waiting, true);
      assert.equal(session.forwardAudio, true);
      assert.ok(session.speechLabeledCount >= 1);
    } finally {
      geminiLiveService.sendPcm16kAudio = original;
    }
  });

  it('utterance after wait clears waiting without requiring resume phrase', async () => {
    const session = {
      callSid: 'CA_WAIT_UTTER',
      liveSession: null,
      waiting: true,
      forwardAudio: true,
      history: [],
    };
    await liveCallSession.onCallerUtterance(
      session,
      'Tell me about your company'
    );
    assert.equal(session.waiting, false);
    assert.equal(session.forwardAudio, true);
  });

  it('noise fragment de while waiting does not clear waiting or become history', async () => {
    const session = {
      callSid: 'CA_WAIT_DE',
      liveSession: null,
      waiting: true,
      waitPhase: 'WAITING',
      forwardAudio: true,
      history: [],
    };
    await liveCallSession.onCallerUtterance(session, 'de');
    assert.equal(session.waiting, true);
    assert.equal(session.waitPhase, 'WAITING');
    assert.equal(session.history.length, 0);
  });

  it('repeat wait while waiting stays waiting and clears playback', async () => {
    const clears = [];
    const session = {
      callSid: 'CA_WAIT_REPEAT',
      liveSession: {
        sendRealtimeInput() {},
        close() {
          session._closed = true;
        },
      },
      waiting: true,
      forwardAudio: true,
      history: [],
      streamSid: 'MZ_WAIT',
      playbackGeneration: 2,
      outboundRemainder: Buffer.alloc(0),
      twilioWs: {
        readyState: 1,
        send(raw) {
          clears.push(JSON.parse(raw));
        },
      },
    };
    await liveCallSession.onCallerUtterance(session, 'hold on');
    assert.equal(session.waiting, true);
    assert.equal(session.forwardAudio, true);
    assert.ok(session.playbackGeneration > 2);
    assert.ok(clears.some((m) => m.event === 'clear'));
    assert.equal(session._closed, undefined);
  });

  it('wait while AI speaking clears Twilio and never ends the call', async () => {
    const clears = [];
    let endCalled = false;
    const session = {
      callSid: 'CA_WAIT_SPEAKING',
      liveSession: {
        sendRealtimeInput() {},
        close() {
          session._closed = true;
        },
      },
      waiting: false,
      forwardAudio: true,
      aiSpeaking: true,
      history: [],
      streamSid: 'MZ_SPEAK',
      playbackGeneration: 0,
      outboundRemainder: Buffer.alloc(0),
      suppressStaleOutput: false,
      twilioWs: {
        readyState: 1,
        send(raw) {
          clears.push(JSON.parse(raw));
        },
      },
    };
    const originalEnd = liveCallSession.endLiveCall;
    liveCallSession.endLiveCall = async () => {
      endCalled = true;
    };
    try {
      await liveCallSession.onCallerUtterance(session, 'wait a second');
      assert.equal(session.waiting, true);
      assert.equal(session.aiSpeaking, false);
      assert.equal(session.suppressStaleOutput, true);
      assert.ok(clears.some((m) => m.event === 'clear'));
      assert.equal(endCalled, false);
      assert.equal(session._closed, undefined);
    } finally {
      liveCallSession.endLiveCall = originalEnd;
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
    assert.equal(
      cfg.automaticActivityDetection.startOfSpeechSensitivity,
      StartSensitivity.START_SENSITIVITY_LOW
    );
    assert.equal(cfg.automaticActivityDetection.prefixPaddingMs, 150);
    assert.equal(cfg.automaticActivityDetection.silenceDurationMs, 500);
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
  it('confirmed barge-in clears and suppresses stale generation audio', () => {
    const sent = [];
    const gate = createSpeechGateState();
    // Confirm barge-in while AI speaking (~120ms+ speech).
    for (let i = 0; i < 8; i += 1) {
      evaluateFrame(makeSpeechLikePcm16k(), gate, {
        aiSpeaking: true,
        nowMs: Date.now(),
      });
    }
    assert.equal(gate.open, true);

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
      speechGate: gate,
      lastTwilioClearAt: null,
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
    assert.equal(session.forwardAudio !== false, true);
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

  it('unconfirmed noise interrupt does not clear Twilio', () => {
    const sent = [];
    const session = {
      callSid: 'CA_NOISE_INT',
      streamSid: 'MZ_NOISE',
      waiting: false,
      forwardAudio: true,
      ending: false,
      liveSessionEpoch: 1,
      playbackGeneration: 0,
      geminiChunkCount: 0,
      outboundRemainder: Buffer.alloc(0),
      suppressStaleOutput: false,
      aiSpeaking: true,
      speechGate: createSpeechGateState(),
      lastTwilioClearAt: null,
      t0: Date.now(),
      twilioWs: {
        readyState: 1,
        send(raw) {
          sent.push(JSON.parse(raw));
        },
      },
    };
    liveCallSession.handleLiveMessage(
      session,
      { serverContent: { interrupted: true } },
      1
    );
    assert.ok(!sent.some((m) => m.event === 'clear'));
    assert.equal(session.forwardAudio, true);
    assert.equal(session.waiting, false);
    assert.equal(session.suppressStaleOutput, true);
    assert.equal(session.aiSpeaking, false);
    assert.equal(session.playbackGeneration, 1);
  });

  it('debounces repeated Twilio clear within window', () => {
    const sent = [];
    const gate = createSpeechGateState();
    for (let i = 0; i < 8; i += 1) {
      evaluateFrame(makeSpeechLikePcm16k(), gate, {
        aiSpeaking: true,
        nowMs: Date.now(),
      });
    }
    const session = {
      callSid: 'CA_DEB',
      streamSid: 'MZ_DEB',
      waiting: false,
      forwardAudio: true,
      ending: false,
      liveSessionEpoch: 1,
      playbackGeneration: 0,
      geminiChunkCount: 0,
      outboundRemainder: Buffer.alloc(0),
      suppressStaleOutput: false,
      aiSpeaking: true,
      turnFirstAudioLogged: true,
      speechGate: gate,
      lastTwilioClearAt: null,
      t0: Date.now(),
      twilioWs: {
        readyState: 1,
        send(raw) {
          sent.push(JSON.parse(raw));
        },
      },
    };
    const msg = { serverContent: { interrupted: true } };
    liveCallSession.handleLiveMessage(session, msg, 1);
    session.aiSpeaking = true;
    gate.open = true;
    gate.lastBargeAcceptAt = Date.now();
    liveCallSession.handleLiveMessage(session, msg, 1);
    const clears = sent.filter((m) => m.event === 'clear');
    assert.equal(clears.length, 1);
    assert.equal(session.forwardAudio, true);
  });
});
