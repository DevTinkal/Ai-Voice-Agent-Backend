'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const {
  TURN,
  classifyCallerTurn,
  shouldAnswer,
} = require('../src/services/conversationController');
const agentService = require('../src/services/agentService');
const { buildSystemInstruction } = require('../src/config/prompts');
const { mixPcm16 } = require('../src/pipeline/audioMixer');
const { handleFluxMessage } = require('../src/pipeline/deepgramFluxClient');
const { splitSpeakableSentences } = require('../src/pipeline/elevenLabsTts');
const {
  answerWithKnowledge,
  needsKnowledge,
  EMPTY_KNOWLEDGE_SPEECH,
} = require('../src/pipeline/classicLlm');
const {
  decideTurn,
  clearTurnCtrlLogOnStartup,
  TURN_CTRL_LOG_PATH,
  appendTurnCtrl,
} = require('../src/pipeline/conversationOrchestrator');
const { MID_CALL_GREETING_ACK } = require('../src/pipeline/classicCallSession');

describe('classic conversationController', () => {
  it('classifies wait, backchannel, new request, incomplete, complete', () => {
    assert.equal(classifyCallerTurn('wait', {}).class, TURN.WAIT);
    assert.equal(
      classifyCallerTurn('yeah', { aiSpeaking: true }).class,
      TURN.BACKCHANNEL
    );
    assert.equal(
      classifyCallerTurn('yeah, but what is the pricing?', { aiSpeaking: true }).class,
      TURN.NEW_REQUEST
    );
    assert.equal(shouldAnswer(TURN.NEW_REQUEST), true);
    assert.equal(classifyCallerTurn('This is', {}).class, TURN.INCOMPLETE);
    assert.equal(classifyCallerTurn('are you?', {}).class, TURN.INCOMPLETE);
    assert.equal(classifyCallerTurn('you?', {}).class, TURN.INCOMPLETE);
    assert.equal(
      classifyCallerTurn('Who is the CEO of Zapyla?', {}).class,
      TURN.COMPLETE
    );
    assert.equal(classifyCallerTurn('de', {}).class, TURN.NOISE);
  });

  it('after open: hello/Hello? ACK_ONLY; thank-you echo NOISE; caller intro COMPLETE', () => {
    assert.equal(
      classifyCallerTurn('hello', { alreadyGreeted: true }).class,
      TURN.ACK_ONLY
    );
    assert.equal(
      classifyCallerTurn('Hello?', { alreadyGreeted: true }).class,
      TURN.ACK_ONLY
    );
    assert.equal(
      classifyCallerTurn('Thank you. This is.', { alreadyGreeted: true }).class,
      TURN.NOISE
    );
    assert.equal(
      classifyCallerTurn('This is Tinkle.', { alreadyGreeted: true }).class,
      TURN.COMPLETE
    );
    assert.equal(
      classifyCallerTurn('This is technical.', { alreadyGreeted: true }).class,
      TURN.COMPLETE
    );
    assert.equal(
      classifyCallerTurn("I'm Red.", {
        alreadyGreeted: true,
        agentName: 'Red',
      }).class,
      TURN.NOISE
    );
    assert.equal(
      classifyCallerTurn('Who is the CEO of Zapyla?', { alreadyGreeted: true }).class,
      TURN.COMPLETE
    );
    assert.equal(
      classifyCallerTurn('And who is the and who is the', {
        alreadyGreeted: true,
      }).class,
      TURN.INCOMPLETE
    );
  });
});

describe('classic dashboard brain grounding', () => {
  it('extractConfiguredCallContext reads labeled fields only', () => {
    const ctx = agentService.extractConfiguredCallContext(
      'Company: Acme Labs\nRole: SDR\nPurpose: qualify leads\nRandom BrandCorp elsewhere'
    );
    assert.equal(ctx.company, 'Acme Labs');
    assert.equal(ctx.role, 'SDR');
    assert.equal(ctx.purpose, 'qualify leads');
    const plain = agentService.extractConfiguredCallContext(
      'We love BrandCorp and the CEO is Pat.'
    );
    assert.equal(plain.company, null);
  });

  it('thin wrapper includes agent name and CONFIGURED CALL CONTEXT, not prompt body', () => {
    const instruction = agentService.buildAgentSystemInstruction({
      name: 'Red',
      prompts: [
        {
          text: 'Company: Northwind\nInternal secret MARKER_XYZ_999 never inline.',
        },
      ],
      languages: ['en'],
    });
    assert.match(instruction, /spoken name on this call is Red/);
    assert.match(instruction, /CONFIGURED CALL CONTEXT/);
    assert.match(instruction, /Northwind/);
    assert.doesNotMatch(instruction, /MARKER_XYZ_999/);
  });

  it('classic phone wrap adds CRITICAL voice rules', () => {
    const base = agentService.buildAgentSystemInstruction({
      name: 'Red',
      prompts: [{ text: 'Be helpful on calls.' }],
      languages: ['en'],
    });
    const wrapped = buildSystemInstruction(base, new Date(), 'UTC', {
      midCall: false,
      channelLabel: 'classic pipeline',
    });
    assert.match(wrapped, /CRITICAL VOICE OUTPUT RULES/);
    assert.match(wrapped, /classic pipeline/);
    assert.match(wrapped, /searchKnowledge/);
  });

  it('needsKnowledge detects company asks but not bare who-are-you', () => {
    assert.equal(needsKnowledge('Which company do you work for?', false), true);
    assert.equal(needsKnowledge('Who are you?', false), false);
    assert.equal(needsKnowledge("What's your name?", false), false);
    assert.equal(needsKnowledge('hello', false), false);
  });

  it('name-only Who are you? generates without searchKnowledge tools', async () => {
    let capturedTools = null;
    let maxTokens = null;
    const spoken = await answerWithKnowledge({
      systemInstruction: 'You are Red. AGENT IDENTITY name is Red.',
      history: [],
      userText: 'Who are you?',
      generateImpl: async (payload) => {
        capturedTools = payload.config && payload.config.tools;
        maxTokens = payload.config && payload.config.maxOutputTokens;
        return {
          candidates: [
            { content: { parts: [{ text: "I'm Red." }] } },
          ],
        };
      },
      searchImpl: async () => {
        throw new Error('search should not run for name-only');
      },
    });
    assert.equal(spoken, "I'm Red.");
    assert.ok(Array.isArray(capturedTools));
    assert.equal(capturedTools.length, 0);
    assert.equal(maxTokens, 120);
  });

  it('auto-runs searchKnowledge when company ask skips the tool', async () => {
    let searched = false;
    let generateCount = 0;
    const spoken = await answerWithKnowledge({
      systemInstruction: 'You are Red. Use searchKnowledge for company facts.',
      history: [],
      userText: 'Which company do you work for?',
      generateImpl: async () => {
        generateCount += 1;
        if (generateCount === 1) {
          return {
            candidates: [
              {
                content: {
                  parts: [{ text: 'I work at InventedCorp inventing facts.' }],
                },
              },
            ],
          };
        }
        return {
          candidates: [
            {
              content: {
                parts: [{ text: 'I am with Dashboard Co from the prompt.' }],
              },
            },
          ],
        };
      },
      searchImpl: async () => {
        searched = true;
        return {
          found: true,
          snippets: [{ text: 'Company name is Dashboard Co from Agent Prompt.' }],
        };
      },
    });
    assert.equal(searched, true);
    assert.ok(generateCount >= 2);
    assert.match(spoken, /Dashboard Co/);
  });

  it('refuses invent when company search is empty', async () => {
    const spoken = await answerWithKnowledge({
      systemInstruction: 'You are Red.',
      history: [],
      userText: 'What is your company pricing?',
      generateImpl: async () => ({
        candidates: [
          { content: { parts: [{ text: 'Pricing is one million dollars.' }] } },
        ],
      }),
      searchImpl: async () => ({ found: false, snippets: [] }),
    });
    assert.equal(spoken, EMPTY_KNOWLEDGE_SPEECH);
  });
});

describe('classic orchestrator decideTurn', () => {
  it('skips backchannel and keeps incomplete', () => {
    const skip = decideTurn({ aiSpeaking: true, waiting: false }, 'okay');
    assert.equal(skip.action, 'SKIP_BACKCHANNEL');
    const hold = decideTurn({ aiSpeaking: false, waiting: false }, 'This is');
    assert.equal(hold.action, 'KEEP_LISTENING');
    const scrap = decideTurn({ aiSpeaking: false, waiting: false }, 'are you?');
    assert.equal(scrap.action, 'KEEP_LISTENING');
    const wait = decideTurn({ waiting: false }, 'hold on');
    assert.equal(wait.action, 'ENTER_WAIT');
  });

  it('after primed open: echo scrap DROP, hello ACK_ONLY, CEO ask ANSWER', () => {
    const greeted = {
      greeted: true,
      greetingClipReady: true,
      classicEchoGuardUntil: 0,
      aiSpeaking: false,
      waiting: false,
      agentName: 'Red',
    };
    const echo = decideTurn(greeted, 'Thank you. This is.');
    assert.equal(echo.action, 'DROP');
    assert.equal(echo.decision.class, TURN.NOISE);

    const hello = decideTurn(greeted, 'hello');
    assert.equal(hello.action, 'ACK_ONLY');
    assert.match(MID_CALL_GREETING_ACK, /help/i);

    const helloQ = decideTurn(greeted, 'Hello?');
    assert.equal(helloQ.action, 'ACK_ONLY');

    const intro = decideTurn(greeted, 'This is Tinkle.');
    assert.equal(intro.action, 'ANSWER');
    assert.equal(intro.decision.class, TURN.COMPLETE);

    const stutter = decideTurn(greeted, 'And who is the and who is the');
    assert.equal(stutter.action, 'KEEP_LISTENING');

    const ask = decideTurn(greeted, 'Who is the CEO of Zapyla?');
    assert.equal(ask.action, 'ANSWER');

    const okayWait = decideTurn(greeted, 'Okay. Wait.');
    assert.equal(okayWait.action, 'ENTER_WAIT');
    assert.equal(okayWait.decision.class, TURN.WAIT);
  });

  it('primeClassic no-ops when already greeted with assistant history', async () => {
    const { primeClassic } = require('../src/pipeline/classicCallSession');
    const session = {
      callSid: 'CA_PRIME_SKIP',
      greeted: true,
      history: [{ role: 'assistant', content: 'Hey, this is Red.' }],
      classicAbort: new AbortController(),
    };
    const before = session.history.length;
    await primeClassic(session, false);
    assert.equal(session.history.length, before);
  });

  it('concurrent classicPrimePromise is shared (no second prime)', async () => {
    const liveCallSession = require('../src/services/liveCallSession');
    const classicPipeline = require('../src/pipeline/classicCallSession');
    const callSid = 'CA_PRIME_SHARE';
    const session = {
      callSid,
      greetingClipReady: false,
      greeted: false,
      pipeline: null,
      classicAbort: new AbortController(),
      history: [],
      pendingOutboundPcm: [],
      agentPrompt: 'Thin wrapper',
      agentName: 'Red',
    };
    liveCallSession.sessions.set(callSid, session);

    let primeStarts = 0;
    const originalPrime = classicPipeline.primeClassic;
    classicPipeline.primeClassic = async (s) => {
      primeStarts += 1;
      await new Promise((r) => setTimeout(r, 40));
      s.greeted = true;
      if (!Array.isArray(s.history)) s.history = [];
      s.history.push({ role: 'assistant', content: 'Hi from prime.' });
      return s;
    };

    const envMod = require('../src/config/env');
    const prior = envMod.env.voicePipeline;
    envMod.env.voicePipeline = 'classic';
    try {
      const p1 = liveCallSession.primeOutboundLive(callSid, {
        from: '+1',
        to: '+2',
        atDial: true,
      });
      const p2 = liveCallSession.primeOutboundLive(callSid, {
        from: '+1',
        to: '+2',
        atDial: false,
      });
      // async function wraps returns — inner classicPrimePromise must be shared.
      assert.ok(session.classicPrimePromise);
      await Promise.all([p1, p2]);
      assert.equal(primeStarts, 1);
      assert.equal(
        session.history.filter((m) => m.role === 'assistant').length,
        1
      );
    } finally {
      envMod.env.voicePipeline = prior;
      classicPipeline.primeClassic = originalPrime;
      liveCallSession.sessions.delete(callSid);
    }
  });

  it('echo guard window drops all finals briefly after Play greeting', () => {
    const session = {
      greeted: true,
      greetingPlayedViaTwiml: true,
      classicEchoGuardUntil: Date.now() + 5000,
      aiSpeaking: false,
      waiting: false,
    };
    const drop = decideTurn(session, 'Who is the CEO of Zapyla?');
    assert.equal(drop.action, 'DROP');
    assert.equal(drop.decision.reason, 'echo_guard_window');
  });

  it('persists TURN_CTRL lines', () => {
    clearTurnCtrlLogOnStartup();
    appendTurnCtrl(
      { callSid: 'CA_CLASSIC', aiSpeaking: false, waiting: false },
      { class: 'COMPLETE', reason: 'clear_utterance', text: 'Hello there' },
      'ANSWER'
    );
    const body = fs.readFileSync(TURN_CTRL_LOG_PATH, 'utf8');
    assert.match(body, /class=COMPLETE/);
    assert.match(body, /words=2/);
    clearTurnCtrlLogOnStartup();
    assert.equal(fs.readFileSync(TURN_CTRL_LOG_PATH, 'utf8'), '');
  });
});

describe('classic audio mixer', () => {
  it('ducks a looping bed under voice', () => {
    const voice = Buffer.alloc(8);
    voice.writeInt16LE(1000, 0);
    voice.writeInt16LE(1000, 2);
    voice.writeInt16LE(1000, 4);
    voice.writeInt16LE(1000, 6);
    const bed = Buffer.alloc(4);
    bed.writeInt16LE(10000, 0);
    bed.writeInt16LE(-10000, 2);
    const mixed = mixPcm16(voice, { enabled: true, gain: 0.1, cursor: 0, bed });
    assert.equal(mixed.pcm.length, voice.length);
    assert.notEqual(mixed.pcm.readInt16LE(0), 1000);
    assert.equal(mixed.cursor, 0);
  });

  it('returns voice unchanged when ambience disabled', () => {
    const voice = Buffer.from([1, 0, 2, 0]);
    const mixed = mixPcm16(voice, {
      enabled: false,
      gain: 0.2,
      bed: Buffer.alloc(4),
    });
    assert.equal(mixed.pcm.equals(voice), true);
  });
});

describe('classic flux + sentence split', () => {
  it('emits endOfTurn from Flux payload', () => {
    const events = [];
    handleFluxMessage(
      JSON.stringify({ event: 'EndOfTurn', transcript: 'Who is the CEO?' }),
      (name, payload) => events.push({ name, text: payload.text })
    );
    assert.ok(events.some((e) => e.name === 'endOfTurn' && /CEO/.test(e.text)));
  });

  it('splits speakable sentences', () => {
    const parts = splitSpeakableSentences('Sure. Here is the cost.');
    assert.equal(parts.length, 2);
  });
});
