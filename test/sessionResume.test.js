'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const geminiLiveService = require('../src/services/geminiLiveService');
const liveCallSession = require('../src/services/liveCallSession');

describe('Gemini Live session management', () => {
  afterEach(() => {
    for (const callSid of [...liveCallSession.sessions.keys()]) {
      const s = liveCallSession.sessions.get(callSid);
      if (s) {
        s.ending = true;
        if (s.reconnectTimer) {
          clearTimeout(s.reconnectTimer);
          s.reconnectTimer = null;
        }
      }
      liveCallSession.sessions.delete(callSid);
    }
  });

  it('parseLiveMessage extracts goAway and sessionResumptionUpdate', () => {
    const parsed = geminiLiveService.parseLiveMessage({
      goAway: { timeLeft: '12.5s' },
      sessionResumptionUpdate: {
        resumable: true,
        newHandle: 'tok-123',
      },
    });
    assert.deepEqual(parsed.goAway, { timeLeft: '12.5s' });
    assert.equal(parsed.sessionResumptionUpdate.resumable, true);
    assert.equal(parsed.sessionResumptionUpdate.newHandle, 'tok-123');
  });

  it('stores resumption handle from SessionResumptionUpdate', () => {
    const session = {
      callSid: 'CA_HANDLE',
      ending: false,
      liveSessionEpoch: 1,
      resumptionHandle: null,
      history: [],
      inputTranscriptBuffer: '',
      outputTranscriptBuffer: '',
      playbackGeneration: 0,
      outboundRemainder: Buffer.alloc(0),
      twilioWs: { readyState: 1, send() {} },
    };
    liveCallSession.handleLiveMessage(
      session,
      {
        sessionResumptionUpdate: {
          resumable: true,
          newHandle: 'resume-xyz',
        },
      },
      1
    );
    assert.equal(session.resumptionHandle, 'resume-xyz');
  });

  it('does not store handle when resumable=false', () => {
    const session = {
      callSid: 'CA_NOHANDLE',
      ending: false,
      liveSessionEpoch: 1,
      resumptionHandle: 'old',
      history: [],
      inputTranscriptBuffer: '',
      outputTranscriptBuffer: '',
      playbackGeneration: 0,
      outboundRemainder: Buffer.alloc(0),
      twilioWs: { readyState: 1, send() {} },
    };
    liveCallSession.handleLiveMessage(
      session,
      {
        sessionResumptionUpdate: {
          resumable: false,
          newHandle: '',
        },
      },
      1
    );
    assert.equal(session.resumptionHandle, 'old');
  });

  it('reconnectLiveSession resumes with stored handle and bumps epoch', async () => {
    const connects = [];
    const original = geminiLiveService.connectLiveSession;
    geminiLiveService.connectLiveSession = async (handlers) => {
      connects.push({
        handle: handlers.sessionResumptionHandle || null,
        midCall: handlers.midCall,
      });
      return {
        close() {},
        sendRealtimeInput() {},
        sendClientContent() {},
      };
    };

    try {
      const oldSocket = { closed: false, close() { this.closed = true; } };
      const session = {
        callSid: 'CA_RESUME',
        streamSid: 'MZ1',
        twilioWs: { readyState: 1, send() {} },
        liveSession: oldSocket,
        liveSessionEpoch: 3,
        resumptionHandle: 'h-99',
        reconnecting: false,
        connecting: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        ending: false,
        greeted: true,
        waiting: false,
        forwardAudio: true,
        playbackGeneration: 0,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        aiSpeaking: false,
        turnFirstAudioLogged: false,
        t0: Date.now(),
        agentPrompt: 'Test agent system instruction for reconnect.',
        agentName: 'Test Agent',
        agentId: 'agent-1',
      };
      liveCallSession.sessions.set('CA_RESUME', session);

      const ok = await liveCallSession.reconnectLiveSession(session, 'onclose');
      assert.equal(ok, true);
      assert.equal(session.liveSessionEpoch, 4);
      assert.equal(session.reconnectAttempts, 0);
      assert.equal(session.reconnecting, false);
      assert.ok(session.liveSession);
      assert.equal(oldSocket.closed, true);
      assert.equal(connects.length, 1);
      assert.equal(connects[0].handle, 'h-99');
      assert.equal(connects[0].midCall, true);
    } finally {
      geminiLiveService.connectLiveSession = original;
    }
  });

  it('prevents concurrent reconnect attempts', async () => {
    let connectCount = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const original = geminiLiveService.connectLiveSession;
    geminiLiveService.connectLiveSession = async () => {
      connectCount += 1;
      await gate;
      return { close() {} };
    };

    try {
      const session = {
        callSid: 'CA_ONCE',
        streamSid: 'MZ1',
        twilioWs: { readyState: 1, send() {} },
        liveSession: { close() {} },
        liveSessionEpoch: 1,
        resumptionHandle: 'h1',
        reconnecting: false,
        connecting: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        ending: false,
        greeted: true,
        playbackGeneration: 0,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        aiSpeaking: false,
        turnFirstAudioLogged: false,
        t0: Date.now(),
        agentPrompt: 'Concurrent reconnect test prompt.',
        agentName: 'Test',
      };
      liveCallSession.sessions.set('CA_ONCE', session);

      const p1 = liveCallSession.reconnectLiveSession(session, 'goAway');
      const p2 = liveCallSession.reconnectLiveSession(session, 'goAway');
      release();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert.equal(r1, true);
      assert.equal(r2, false);
      assert.equal(connectCount, 1);
    } finally {
      geminiLiveService.connectLiveSession = original;
    }
  });

  it('goAway message triggers reconnect with handle', async () => {
    const connects = [];
    const original = geminiLiveService.connectLiveSession;
    geminiLiveService.connectLiveSession = async (handlers) => {
      connects.push(handlers.sessionResumptionHandle || null);
      return { close() {} };
    };

    try {
      const session = {
        callSid: 'CA_GOAWAY',
        streamSid: 'MZ1',
        twilioWs: { readyState: 1, send() {} },
        liveSession: { close() {} },
        liveSessionEpoch: 2,
        resumptionHandle: 'go-handle',
        reconnecting: false,
        connecting: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        ending: false,
        greeted: true,
        history: [],
        inputTranscriptBuffer: '',
        outputTranscriptBuffer: '',
        playbackGeneration: 0,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        aiSpeaking: false,
        turnFirstAudioLogged: false,
        t0: Date.now(),
        agentPrompt: 'GoAway reconnect test prompt.',
        agentName: 'Test',
      };
      liveCallSession.sessions.set('CA_GOAWAY', session);

      liveCallSession.handleLiveMessage(
        session,
        { goAway: { timeLeft: '5s' } },
        2
      );

      // goAway kicks off async reconnect — wait briefly
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(connects.length, 1);
      assert.equal(connects[0], 'go-handle');
      assert.ok(session.liveSessionEpoch >= 3);
    } finally {
      geminiLiveService.connectLiveSession = original;
    }
  });

  it('skips reconnect when Twilio stream is closed', async () => {
    const original = geminiLiveService.connectLiveSession;
    let called = false;
    geminiLiveService.connectLiveSession = async () => {
      called = true;
      return { close() {} };
    };

    try {
      const session = {
        callSid: 'CA_DEAD_TWILIO',
        twilioWs: { readyState: 3 },
        liveSession: null,
        liveSessionEpoch: 1,
        resumptionHandle: 'h',
        reconnecting: false,
        connecting: false,
        reconnectAttempts: 0,
        reconnectTimer: null,
        ending: false,
        greeted: true,
      };
      liveCallSession.sessions.set('CA_DEAD_TWILIO', session);
      const ok = await liveCallSession.reconnectLiveSession(session, 'onclose');
      assert.equal(ok, false);
      assert.equal(called, false);
    } finally {
      geminiLiveService.connectLiveSession = original;
    }
  });

  it('bounds reconnect attempts after repeated failures', async () => {
    const original = geminiLiveService.connectLiveSession;
    geminiLiveService.connectLiveSession = async () => {
      throw new Error('boom');
    };

    try {
      const session = {
        callSid: 'CA_FAIL',
        streamSid: 'MZ1',
        twilioWs: { readyState: 1, send() {} },
        liveSession: null,
        liveSessionEpoch: 1,
        resumptionHandle: null,
        reconnecting: false,
        connecting: false,
        reconnectAttempts: liveCallSession.LIVE_RECONNECT_MAX_ATTEMPTS,
        reconnectTimer: null,
        ending: false,
        greeted: true,
        playbackGeneration: 0,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        t0: Date.now(),
      };
      liveCallSession.sessions.set('CA_FAIL', session);
      const ok = await liveCallSession.reconnectLiveSession(session, 'onclose');
      assert.equal(ok, false);
      assert.equal(session.liveSession, null);
    } finally {
      geminiLiveService.connectLiveSession = original;
    }
  });
});
