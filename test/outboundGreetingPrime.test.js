'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const liveCallSession = require('../src/services/liveCallSession');
const geminiLiveService = require('../src/services/geminiLiveService');
const agentService = require('../src/services/agentService');
const callService = require('../src/services/callService');

describe('outbound greeting prime', () => {
  it('buffers Gemini PCM until Twilio Media Stream attaches then flushes once', async () => {
    const callSid = 'CA_PRIME_GREET_1';
    const sentFrames = [];
    const originalConnect = geminiLiveService.connectLiveSession;
    const originalGreeting = geminiLiveService.requestGreeting;
    const originalLoad =
      agentService.requireAgentForCall || null;
    const originalGetById = agentService.getAgentById;
    const originalGetCall = callService.getCallBySid;
    const originalMarkAnswered = callService.markAnswered;
    const originalMarkInProgress = callService.markInProgress;
    const originalAssert = agentService.assertLivePromptSize;

    let greetingCalls = 0;
    let onmessage = null;

    geminiLiveService.connectLiveSession = async (handlers) => {
      onmessage = handlers.onmessage;
      return {
        sendClientContent() {},
        sendRealtimeInput() {},
        close() {},
      };
    };
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
    agentService.assertLivePromptSize = () =>
      'Thin wrapper instruction for tests';
    callService.getCallBySid = async () => ({
      callSid,
      agentId: 'agent1',
    });
    callService.markAnswered = async () => null;
    callService.markInProgress = async () => null;

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

      // Simulate Gemini greeting audio before Media Stream is ready.
      const fakePcm = Buffer.alloc(4800);
      for (let i = 0; i < fakePcm.length; i += 2) {
        fakePcm.writeInt16LE(1000, i);
      }
      liveCallSession.playGeminiPcmOnce(
        primed,
        fakePcm,
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

      // Attach path must not request a second greeting.
      assert.equal(greetingCalls, 1);
      assert.equal(primed.pendingOutboundPcm.length, 0);
      assert.ok(sentFrames.length > 0);
      assert.equal(primed.streamSid, 'MZ_PRIME_1');
    } finally {
      geminiLiveService.connectLiveSession = originalConnect;
      geminiLiveService.requestGreeting = originalGreeting;
      agentService.getAgentById = originalGetById;
      if (originalLoad) {
        agentService.requireAgentForCall = originalLoad;
      }
      callService.getCallBySid = originalGetCall;
      callService.markAnswered = originalMarkAnswered;
      callService.markInProgress = originalMarkInProgress;
      agentService.assertLivePromptSize = originalAssert;
      await liveCallSession.endLiveCall(callSid, 'test_done').catch(() => {});
      void onmessage;
    }
  });

  it('startLiveCall without prime still greets once', async () => {
    const callSid = 'CA_PRIME_FALLBACK';
    let greetingCalls = 0;
    const originalConnect = geminiLiveService.connectLiveSession;
    const originalGreeting = geminiLiveService.requestGreeting;
    const originalGetById = agentService.getAgentById;
    const originalGetCall = callService.getCallBySid;
    const originalMarkAnswered = callService.markAnswered;
    const originalMarkInProgress = callService.markInProgress;
    const originalAssert = agentService.assertLivePromptSize;

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
      geminiLiveService.connectLiveSession = originalConnect;
      geminiLiveService.requestGreeting = originalGreeting;
      agentService.getAgentById = originalGetById;
      callService.getCallBySid = originalGetCall;
      callService.markAnswered = originalMarkAnswered;
      callService.markInProgress = originalMarkInProgress;
      agentService.assertLivePromptSize = originalAssert;
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

    const originalConnect = geminiLiveService.connectLiveSession;
    const originalGreeting = geminiLiveService.requestGreeting;
    const originalGetById = agentService.getAgentById;
    const originalGetCall = callService.getCallBySid;
    const originalMarkAnswered = callService.markAnswered;
    const originalMarkInProgress = callService.markInProgress;
    const originalAssert = agentService.assertLivePromptSize;

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

    try {
      const primePromise = liveCallSession.primeOutboundLive(callSid, {
        from: '+1000',
        to: '+2000',
        agentId: 'agent1',
      });

      // Media Stream arrives while Gemini connect is still gated.
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
      geminiLiveService.connectLiveSession = originalConnect;
      geminiLiveService.requestGreeting = originalGreeting;
      agentService.getAgentById = originalGetById;
      callService.getCallBySid = originalGetCall;
      callService.markAnswered = originalMarkAnswered;
      callService.markInProgress = originalMarkInProgress;
      agentService.assertLivePromptSize = originalAssert;
      await liveCallSession.endLiveCall(callSid, 'test_done').catch(() => {});
    }
  });
});
