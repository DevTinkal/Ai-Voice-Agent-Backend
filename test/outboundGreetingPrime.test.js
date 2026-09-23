'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const liveCallSession = require('../src/services/liveCallSession');
const geminiLiveService = require('../src/services/geminiLiveService');
const agentService = require('../src/services/agentService');
const callService = require('../src/services/callService');
const {
  buildMediaStreamTwiml,
} = require('../src/controllers/voiceController');
const { createApp } = require('../src/app');
const { env } = require('../src/config/env');

function mockAgentAndCall(callSid) {
  const originalConnect = geminiLiveService.connectLiveSession;
  const originalGreeting = geminiLiveService.requestGreeting;
  const originalGetById = agentService.getAgentById;
  const originalGetCall = callService.getCallBySid;
  const originalMarkAnswered = callService.markAnswered;
  const originalMarkInProgress = callService.markInProgress;
  const originalMarkCompleted = callService.markCompleted;
  const originalAssert = agentService.assertLivePromptSize;

  let greetingCalls = 0;
  let twilioSendCount = 0;

  geminiLiveService.connectLiveSession = async () => ({
    sendClientContent() {},
    sendRealtimeInput() {},
    close() {},
  });
  geminiLiveService.requestGreeting = () => {
    greetingCalls += 1;
  };
  agentService.getAgentById = async () => ({
    _id: 'agent1',
    name: 'Deep',
    status: 'active',
    prompts: [{ text: 'You are Deep.' }],
    languages: ['English'],
  });
  agentService.assertLivePromptSize = () => 'Thin wrapper';
  callService.getCallBySid = async () => ({ callSid, agentId: 'agent1' });
  callService.markAnswered = async () => null;
  callService.markInProgress = async () => null;
  callService.markCompleted = async () => ({ callSid, duration: 0 });

  return {
    greetingCalls: () => greetingCalls,
    twilioSendCount: () => twilioSendCount,
    trackTwilioWs() {
      return {
        readyState: 1,
        send() {
          twilioSendCount += 1;
        },
      };
    },
    restore() {
      geminiLiveService.connectLiveSession = originalConnect;
      geminiLiveService.requestGreeting = originalGreeting;
      agentService.getAgentById = originalGetById;
      callService.getCallBySid = originalGetCall;
      callService.markAnswered = originalMarkAnswered;
      callService.markInProgress = originalMarkInProgress;
      callService.markCompleted = originalMarkCompleted;
      agentService.assertLivePromptSize = originalAssert;
    },
  };
}

function fakeGreetingPcm() {
  const fakePcm = Buffer.alloc(9600);
  for (let i = 0; i < fakePcm.length; i += 2) {
    fakePcm.writeInt16LE(2000, i);
  }
  return fakePcm;
}

describe('outbound greeting prime', () => {
  it('buffers Gemini PCM until Twilio Media Stream attaches then flushes once', async () => {
    const callSid = 'CA_PRIME_GREET_1';
    const sentFrames = [];
    const mocks = mockAgentAndCall(callSid);
    let greetingCalls = 0;
    geminiLiveService.requestGreeting = () => {
      greetingCalls += 1;
    };

    try {
      liveCallSession.beginFirstResponseTimeline(callSid);
      const primed = await liveCallSession.primeOutboundLive(callSid, {
        from: '+1000',
        to: '+2000',
        agentId: 'agent1',
      });
      assert.ok(primed);
      assert.equal(primed.greeted, true);
      assert.equal(greetingCalls, 1);
      assert.ok(primed.liveSession);
      assert.equal(primed.twilioWs, null);

      liveCallSession.playGeminiPcmOnce(
        primed,
        fakeGreetingPcm(),
        primed.playbackGeneration
      );
      assert.ok(primed.pendingOutboundPcm.length >= 1);

      const twilioWs = {
        readyState: 1,
        send(raw) {
          const msg = JSON.parse(raw);
          if (msg.event === 'media') {
            sentFrames.push(msg);
          }
        },
      };

      await liveCallSession.startLiveCall({
        twilioWs,
        callSid,
        streamSid: 'MZ_PRIME_1',
        from: '+1000',
        to: '+2000',
      });

      assert.equal(greetingCalls, 1);
      assert.equal(primed.pendingOutboundPcm.length, 0);
      assert.ok(sentFrames.length > 0);
      assert.equal(primed.streamSid, 'MZ_PRIME_1');
    } finally {
      mocks.restore();
      await liveCallSession.endLiveCall(callSid, 'test_done').catch(() => {});
    }
  });

  it('startLiveCall without prime still greets once', async () => {
    const callSid = 'CA_PRIME_FALLBACK';
    const mocks = mockAgentAndCall(callSid);
    let greetingCalls = 0;
    geminiLiveService.requestGreeting = () => {
      greetingCalls += 1;
    };

    try {
      const twilioWs = { readyState: 1, send() {} };
      const session = await liveCallSession.startLiveCall({
        twilioWs,
        callSid,
        streamSid: 'MZ_FB',
        from: '+1',
        to: '+2',
      });
      assert.equal(session.greeted, true);
      assert.equal(greetingCalls, 1);
      assert.ok(session.liveSession);
    } finally {
      mocks.restore();
      await liveCallSession.endLiveCall(callSid, 'test_done').catch(() => {});
    }
  });

  it('Media Stream before prime completes: one session, one greeting', async () => {
    const callSid = 'CA_PRIME_RACE';
    let greetingCalls = 0;
    let connectCalls = 0;
    let releaseConnect;
    const connectGate = new Promise((resolve) => {
      releaseConnect = resolve;
    });
    const mocks = mockAgentAndCall(callSid);

    geminiLiveService.connectLiveSession = async () => {
      connectCalls += 1;
      await connectGate;
      return {
        sendClientContent() {},
        sendRealtimeInput() {},
        close() {},
      };
    };
    geminiLiveService.requestGreeting = () => {
      greetingCalls += 1;
    };

    try {
      const primePromise = liveCallSession.primeOutboundLive(callSid, {
        from: '+1000',
        to: '+2000',
        agentId: 'agent1',
      });

      const attachPromise = liveCallSession.startLiveCall({
        twilioWs: { readyState: 1, send() {} },
        callSid,
        streamSid: 'MZ_RACE',
        from: '+1000',
        to: '+2000',
      });

      releaseConnect();
      const [primed, attached] = await Promise.all([primePromise, attachPromise]);

      assert.equal(connectCalls, 1);
      assert.equal(greetingCalls, 1);
      assert.equal(primed, attached);
      assert.ok(attached.liveSession);
      assert.equal(attached.greeted, true);
      assert.equal(attached.streamSid, 'MZ_RACE');
    } finally {
      mocks.restore();
      await liveCallSession.endLiveCall(callSid, 'test_done').catch(() => {});
    }
  });

  it('dial prime buffers only — no Twilio send while ringing; clip ready for answer Play', async () => {
    const callSid = 'CAeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    const mocks = mockAgentAndCall(callSid);
    let greetingCalls = 0;
    geminiLiveService.requestGreeting = () => {
      greetingCalls += 1;
    };

    try {
      const primed = await liveCallSession.primeOutboundLive(callSid, {
        from: '+1000',
        to: '+2000',
        agentId: 'agent1',
        atDial: true,
      });
      assert.equal(primed.primedAtDial, true);
      assert.equal(greetingCalls, 1);
      assert.equal(primed.twilioWs, null);

      liveCallSession.playGeminiPcmOnce(
        primed,
        fakeGreetingPcm(),
        primed.playbackGeneration
      );
      assert.ok(primed.pendingOutboundPcm.length >= 1);
      assert.equal(mocks.twilioSendCount(), 0);

      liveCallSession.maybeFinalizeOutboundGreetingClip(primed);
      assert.equal(primed.greetingClipReady, true);
      assert.ok(primed.greetingClip && primed.greetingClip.length > 44);
      assert.equal(liveCallSession.hasOutboundGreetingClip(callSid), true);

      // Clip must not be served before answer authorization.
      assert.equal(liveCallSession.consumeOutboundGreetingClip(callSid), null);

      assert.equal(liveCallSession.authorizeOutboundGreetingPlay(callSid), true);
      const clip = liveCallSession.consumeOutboundGreetingClip(callSid);
      assert.ok(clip);
      assert.equal(clip.toString('ascii', 0, 4), 'RIFF');

      // Attach after Play: no second greeting, no flush replay.
      await liveCallSession.startLiveCall({
        twilioWs: mocks.trackTwilioWs(),
        callSid,
        streamSid: 'MZ_PLAY',
        from: '+1000',
        to: '+2000',
      });
      assert.equal(greetingCalls, 1);
      assert.equal(mocks.twilioSendCount(), 0);
    } finally {
      mocks.restore();
      await liveCallSession.endLiveCall(callSid, 'test_done').catch(() => {});
    }
  });

  it('hangup before answer tears down primed session without play', async () => {
    const callSid = 'CAffffffffffffffffffffffffffffffff';
    const mocks = mockAgentAndCall(callSid);

    try {
      await liveCallSession.primeOutboundLive(callSid, {
        from: '+1',
        to: '+2',
        agentId: 'agent1',
        atDial: true,
      });
      assert.ok(liveCallSession.getSession(callSid));
      await liveCallSession.endLiveCall(callSid, 'no_answer');
      assert.equal(liveCallSession.getSession(callSid), undefined);
      assert.equal(liveCallSession.hasOutboundGreetingClip(callSid), false);
    } finally {
      mocks.restore();
    }
  });

  it('buildMediaStreamTwiml includes Play then Stream when playUrl set', () => {
    const prev = env.mediaStreamWsUrl;
    env.mediaStreamWsUrl = 'wss://example.test/media-stream';
    try {
      const built = buildMediaStreamTwiml('+1', '+2', {
        playUrl: 'https://example.test/voice/outbound-greeting/CAaaa',
      });
      assert.equal(built.ok, true);
      assert.match(built.xml, /<Play>/);
      assert.match(built.xml, /outbound-greeting/);
      assert.match(built.xml, /<Connect>/);
      assert.match(built.xml, /<Stream /);
    } finally {
      env.mediaStreamWsUrl = prev;
    }
  });

  it('GET outbound-greeting returns 404 until Play authorized', async () => {
    const callSid = 'CAbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const mocks = mockAgentAndCall(callSid);
    const prevSkip = env.skipTwilioSignature;
    const prevMedia = env.mediaStreamWsUrl;
    const prevPublic = env.publicBaseUrl;
    env.skipTwilioSignature = true;
    env.mediaStreamWsUrl = 'wss://example.test/media-stream';
    env.publicBaseUrl = 'https://example.test';

    const server = http.createServer(createApp());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    function get(path) {
      return new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port, path }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                body: Buffer.concat(chunks),
              })
            );
          })
          .on('error', reject);
      });
    }

    try {
      await liveCallSession.primeOutboundLive(callSid, {
        agentId: 'agent1',
        atDial: true,
      });
      const session = liveCallSession.getSession(callSid);
      liveCallSession.playGeminiPcmOnce(
        session,
        fakeGreetingPcm(),
        session.playbackGeneration
      );
      liveCallSession.maybeFinalizeOutboundGreetingClip(session);

      const before = await get(`/voice/outbound-greeting/${callSid}`);
      assert.equal(before.status, 404);

      liveCallSession.authorizeOutboundGreetingPlay(callSid);
      const after = await get(`/voice/outbound-greeting/${callSid}`);
      assert.equal(after.status, 200);
      assert.equal(after.body.toString('ascii', 0, 4), 'RIFF');
    } finally {
      mocks.restore();
      env.skipTwilioSignature = prevSkip;
      env.mediaStreamWsUrl = prevMedia;
      env.publicBaseUrl = prevPublic;
      await liveCallSession.endLiveCall(callSid, 'test_done').catch(() => {});
      await new Promise((r) => server.close(r));
    }
  });
});
