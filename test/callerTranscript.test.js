'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseLiveMessage } = require('../src/services/geminiLiveService');
const liveCallSession = require('../src/services/liveCallSession');
const dashboardSocket = require('../src/websocket/dashboardSocket');

describe('caller transcript flush', () => {
  it('parseLiveMessage reads interim + root-level input transcription', () => {
    const parsed = parseLiveMessage({
      serverContent: {
        interimInputTranscription: { text: 'hello there' },
      },
    });
    assert.equal(parsed.interimInputTranscription, 'hello there');

    const root = parseLiveMessage({
      inputTranscription: { text: 'from root', finished: false },
    });
    assert.equal(root.inputTranscription, 'from root');
    assert.equal(root.inputFinished, false);
  });

  it('flushes CALLER_MESSAGE without inputTranscription.finished when model replies', () => {
    const events = [];
    const original = dashboardSocket.broadcast;
    dashboardSocket.broadcast = (event) => events.push(event);

    try {
      const session = {
        callSid: 'CA_CALLER_TX',
        streamSid: 'MZ1',
        waiting: false,
        ending: false,
        playbackGeneration: 0,
        geminiChunkCount: 0,
        twilioFrameCount: 0,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        aiSpeaking: false,
        turnFirstAudioLogged: false,
        t0: 0,
        lastSpeechAudioAt: null,
        geminiUserTurnCompleteAt: null,
        turnGeminiFirstAudioAt: null,
        turnTwilioFirstSendAt: null,
        latencyBreakdownLogged: false,
        inputTranscriptBuffer: '',
        outputTranscriptBuffer: '',
        history: [],
        liveSessionEpoch: 1,
        twilioWs: { readyState: 1, send() {} },
      };

      // Caller fragments with no finished flag (real Gemini JS SDK behavior).
      liveCallSession.handleLiveMessage(
        session,
        {
          serverContent: {
            inputTranscription: { text: 'I need a ' },
          },
        },
        1
      );
      assert.equal(session.inputTranscriptBuffer, 'I need a ');
      assert.ok(events.some((e) => e.type === 'CALLER_STREAMING'));
      assert.ok(!events.some((e) => e.type === 'CALLER_MESSAGE'));

      // Model starts output → should finalize caller without finished=true.
      liveCallSession.handleLiveMessage(
        session,
        {
          serverContent: {
            outputTranscription: { text: 'Sure, happy to help.' },
            turnComplete: true,
          },
        },
        1
      );

      const callerFinal = events.filter((e) => e.type === 'CALLER_MESSAGE');
      assert.equal(callerFinal.length, 1);
      assert.equal(callerFinal[0].data.content, 'I need a');
      assert.equal(session.inputTranscriptBuffer, '');

      const aiFinal = events.filter((e) => e.type === 'AI_RESPONSE');
      assert.equal(aiFinal.length, 1);
      assert.match(aiFinal[0].data.content, /Sure/);
    } finally {
      dashboardSocket.broadcast = original;
    }
  });

  it('early streaming wait enters hold and keeps AI_STREAMING suppressed', () => {
    const events = [];
    const streamEnds = [];
    const original = dashboardSocket.broadcast;
    dashboardSocket.broadcast = (event) => events.push(event);

    try {
      const session = {
        callSid: 'CA_EARLY_WAIT',
        streamSid: 'MZ_WAIT',
        waiting: false,
        ending: false,
        forwardAudio: true,
        playbackGeneration: 1,
        geminiChunkCount: 0,
        twilioFrameCount: 0,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        aiSpeaking: true,
        turnFirstAudioLogged: false,
        t0: 0,
        inputTranscriptBuffer: '',
        outputTranscriptBuffer: 'partial answer',
        history: [],
        liveSessionEpoch: 1,
        liveSession: {
          sendRealtimeInput(payload) {
            streamEnds.push(payload);
          },
        },
        twilioWs: { readyState: 1, send() {} },
      };

      liveCallSession.handleLiveMessage(
        session,
        {
          serverContent: {
            interimInputTranscription: { text: 'wait' },
          },
        },
        1
      );

      assert.equal(session.waiting, true);
      assert.equal(session.forwardAudio, true);
      assert.equal(session.inputTranscriptBuffer, 'wait');
      assert.ok(events.some((e) => e.type === 'AI_WAITING'));
      assert.ok(events.some((e) => e.type === 'CALLER_STREAMING'));
      assert.ok(streamEnds.some((p) => p && p.audioStreamEnd === true));

      // Stale AI output while waiting must not clear Waiting via AI_STREAMING.
      liveCallSession.handleLiveMessage(
        session,
        {
          serverContent: {
            outputTranscription: { text: ' and continue talking.' },
          },
        },
        1
      );
      assert.equal(session.waiting, true);
      assert.equal(session.outputTranscriptBuffer, '');
      assert.ok(!events.some((e) => e.type === 'AI_STREAMING'));

      // Flush finalizes CALLER_MESSAGE with wait; stay held.
      liveCallSession.handleLiveMessage(
        session,
        {
          serverContent: {
            turnComplete: true,
          },
        },
        1
      );
      assert.equal(session.waiting, true);
      const callerMsgs = events.filter((e) => e.type === 'CALLER_MESSAGE');
      assert.ok(callerMsgs.some((e) => e.data.content === 'wait'));
    } finally {
      dashboardSocket.broadcast = original;
    }
  });

  it('de while waiting is dropped — no CALLER_MESSAGE and waiting stays', () => {
    const events = [];
    const original = dashboardSocket.broadcast;
    dashboardSocket.broadcast = (event) => events.push(event);

    try {
      const session = {
        callSid: 'CA_WAIT_NOISE',
        streamSid: 'MZ2',
        waiting: true,
        waitPhase: 'WAITING',
        ending: false,
        forwardAudio: true,
        playbackGeneration: 0,
        outboundRemainder: Buffer.alloc(0),
        aiSpeaking: false,
        inputTranscriptBuffer: '',
        outputTranscriptBuffer: '',
        history: [],
        liveSessionEpoch: 1,
        liveSession: { sendRealtimeInput() {} },
        twilioWs: { readyState: 1, send() {} },
      };

      liveCallSession.handleLiveMessage(
        session,
        {
          serverContent: {
            inputTranscription: { text: 'de' },
            turnComplete: true,
          },
        },
        1
      );

      assert.equal(session.waiting, true);
      assert.equal(session.waitPhase, 'WAITING');
      assert.ok(!events.some((e) => e.type === 'CALLER_MESSAGE'));
      assert.ok(!events.some((e) => e.type === 'AI_STREAMING'));
    } finally {
      dashboardSocket.broadcast = original;
    }
  });

  it('interrupted message carrying wait still enters WAIT (no transcript drop)', () => {
    const events = [];
    const streamEnds = [];
    const original = dashboardSocket.broadcast;
    dashboardSocket.broadcast = (event) => events.push(event);

    try {
      const session = {
        callSid: 'CA_WAIT_INT',
        streamSid: 'MZ_INT',
        waiting: false,
        waitPhase: 'NORMAL',
        waitStreamEndSent: false,
        ending: false,
        forwardAudio: true,
        playbackGeneration: 2,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        aiSpeaking: true,
        speechGate: { open: true, lastAcceptAt: Date.now() },
        lastTwilioClearAt: 0,
        inputTranscriptBuffer: '',
        outputTranscriptBuffer: '',
        history: [],
        liveSessionEpoch: 1,
        liveSession: {
          sendRealtimeInput(payload) {
            streamEnds.push(payload);
          },
        },
        twilioWs: { readyState: 1, send() {} },
        t0: Date.now(),
      };

      liveCallSession.handleLiveMessage(
        session,
        {
          serverContent: {
            interrupted: true,
            interimInputTranscription: { text: 'wait' },
            modelTurn: {
              parts: [{ inlineData: { data: Buffer.alloc(100).toString('base64'), mimeType: 'audio/pcm' } }],
            },
          },
        },
        1
      );

      assert.equal(session.waiting, true);
      assert.equal(session.waitPhase, 'WAITING');
      assert.ok(events.some((e) => e.type === 'AI_WAITING'));
      assert.ok(streamEnds.some((p) => p && p.audioStreamEnd === true));
      // Interrupted audio must not play after WAIT.
      assert.equal(session.geminiChunkCount || 0, 0);
    } finally {
      dashboardSocket.broadcast = original;
    }
  });

  it('partial wa then wait while AI speaking enters WAIT without losing prefix', () => {
    const events = [];
    const original = dashboardSocket.broadcast;
    dashboardSocket.broadcast = (event) => events.push(event);

    try {
      const session = {
        callSid: 'CA_WAIT_PARTIAL',
        streamSid: 'MZ_P',
        waiting: false,
        waitPhase: 'NORMAL',
        waitStreamEndSent: false,
        ending: false,
        forwardAudio: true,
        playbackGeneration: 1,
        outboundRemainder: Buffer.alloc(0),
        aiSpeaking: true,
        turnGeminiFirstAudioAt: 1,
        inputTranscriptBuffer: '',
        outputTranscriptBuffer: '',
        history: [],
        liveSessionEpoch: 1,
        liveSession: { sendRealtimeInput() {} },
        twilioWs: { readyState: 1, send() {} },
        t0: 0,
      };

      // Partial prefix while AI speaking — must NOT flush away.
      liveCallSession.handleLiveMessage(
        session,
        {
          serverContent: {
            interimInputTranscription: { text: 'wa' },
            modelTurn: {
              parts: [{ inlineData: { data: Buffer.alloc(40).toString('base64'), mimeType: 'audio/pcm' } }],
            },
          },
        },
        1
      );
      assert.equal(session.waiting, false);
      assert.equal(session.inputTranscriptBuffer, 'wa');
      assert.ok(!events.some((e) => e.type === 'CALLER_MESSAGE'));

      liveCallSession.handleLiveMessage(
        session,
        {
          serverContent: {
            interimInputTranscription: { text: 'wait' },
          },
        },
        1
      );
      assert.equal(session.waiting, true);
      assert.equal(session.waitPhase, 'WAITING');
      assert.ok(events.some((e) => e.type === 'AI_WAITING'));
    } finally {
      dashboardSocket.broadcast = original;
    }
  });

  it('duplicate wait while WAITING is idempotent (one stream end)', () => {
    const streamEnds = [];
    const original = dashboardSocket.broadcast;
    dashboardSocket.broadcast = () => {};

    try {
      const session = {
        callSid: 'CA_WAIT_IDEM',
        streamSid: 'MZ_I',
        waiting: false,
        waitPhase: 'NORMAL',
        waitStreamEndSent: false,
        ending: false,
        forwardAudio: true,
        playbackGeneration: 0,
        outboundRemainder: Buffer.alloc(0),
        aiSpeaking: false,
        inputTranscriptBuffer: '',
        outputTranscriptBuffer: '',
        history: [],
        liveSessionEpoch: 1,
        liveSession: {
          sendRealtimeInput(payload) {
            streamEnds.push(payload);
          },
        },
        twilioWs: { readyState: 1, send() {} },
      };

      liveCallSession.handleLiveMessage(
        session,
        { serverContent: { interimInputTranscription: { text: 'wait' } } },
        1
      );
      assert.equal(session.waitStreamEndSent, true);
      const endsAfterFirst = streamEnds.filter((p) => p && p.audioStreamEnd).length;
      assert.equal(endsAfterFirst, 1);

      liveCallSession.handleLiveMessage(
        session,
        { serverContent: { interimInputTranscription: { text: 'wait' } } },
        1
      );
      assert.equal(session.waiting, true);
      assert.equal(
        streamEnds.filter((p) => p && p.audioStreamEnd).length,
        1
      );
    } finally {
      dashboardSocket.broadcast = original;
    }
  });
});
