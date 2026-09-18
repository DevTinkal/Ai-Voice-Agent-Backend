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
});
