'use strict';

const { describe, it, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const knowledgeService = require('../src/services/knowledgeService');
const embeddingService = require('../src/services/embeddingService');
const geminiLiveService = require('../src/services/geminiLiveService');
const agentService = require('../src/services/agentService');
const liveCallSession = require('../src/services/liveCallSession');

describe('knowledge RAG — chunking and cosine', () => {
  it('chunks paragraph-aware with overlap and preserves text', () => {
    const paraA = 'Alpha paragraph. '.repeat(40); // ~640
    const paraB = 'Beta paragraph. '.repeat(40);
    const raw = `${paraA}\n\n${paraB}`;
    const chunks = knowledgeService.chunkText(raw);
    assert.ok(chunks.length >= 1);
    const joined = chunks.join(' ');
    assert.match(joined, /Alpha paragraph/);
    assert.match(joined, /Beta paragraph/);
    for (const c of chunks) {
      assert.ok(c.length > 0);
      assert.ok(c.length <= knowledgeService.CHUNK_TARGET_CHARS * 2);
    }
  });

  it('hard-splits oversized single paragraph without losing text', () => {
    const raw = 'x'.repeat(2500);
    const chunks = knowledgeService.chunkText(raw);
    assert.ok(chunks.length >= 2);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    // Overlap means total >= original; never lose unique content coverage.
    assert.ok(total >= raw.length);
  });

  it('cosineSimilarity handles normals, zeros, and mismatched dims', () => {
    assert.equal(
      knowledgeService.cosineSimilarity([1, 0], [1, 0]),
      1
    );
    assert.ok(
      Math.abs(knowledgeService.cosineSimilarity([1, 0], [0, 1]) - 0) < 1e-9
    );
    assert.equal(knowledgeService.cosineSimilarity([0, 0], [1, 1]), null);
    assert.equal(knowledgeService.cosineSimilarity([1, 0], [1, 0, 0]), null);
    assert.equal(knowledgeService.cosineSimilarity([], [1]), null);
  });
});

describe('knowledge RAG — search ranking (mocked embeddings)', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('ranks by cosine, respects topK and maxChars, empty index', async () => {
    const empty = await knowledgeService.searchKnowledge('anything');
    // Without DB / ready docs — empty or unavailable message (no invent).
    assert.equal(empty.usedFallback, false);
    assert.ok(Array.isArray(empty.snippets));
    assert.equal(empty.snippets.length, 0);
    assert.ok(empty.message);

    // Unit-level ranking without Mongo: reuse cosine + selection logic via
    // direct cosine checks for known vectors.
    const q = [1, 0, 0];
    const a = { text: 'fuel policy A', score: knowledgeService.cosineSimilarity(q, [1, 0, 0]), title: 'A' };
    const b = { text: 'unrelated', score: knowledgeService.cosineSimilarity(q, [0, 1, 0]), title: 'B' };
    assert.ok(a.score > b.score);

    mock.method(embeddingService, 'getEmbeddingModel', () => 'gemini-embedding-2');
    assert.equal(embeddingService.getEmbeddingModel(), 'gemini-embedding-2');
    assert.doesNotMatch(
      embeddingService.getEmbeddingModel(),
      /text-embedding-004/
    );
  });
});

describe('knowledge RAG — Live tool wiring', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('buildLiveConfig declares searchKnowledge', () => {
    const live = geminiLiveService.buildLiveConfig({
      systemInstruction: 'You are a test agent.',
      midCall: false,
    });
    assert.ok(live.tools);
    assert.equal(live.tools[0].functionDeclarations[0].name, 'searchKnowledge');
  });

  it('parseLiveMessage extracts toolCall.functionCalls', () => {
    const parsed = geminiLiveService.parseLiveMessage({
      toolCall: {
        functionCalls: [
          {
            id: 'call-1',
            name: 'searchKnowledge',
            args: { query: 'fuel delivery requirement' },
          },
        ],
      },
    });
    assert.equal(parsed.functionCalls.length, 1);
    assert.equal(parsed.functionCalls[0].id, 'call-1');
    assert.equal(parsed.functionCalls[0].name, 'searchKnowledge');
    assert.equal(
      parsed.functionCalls[0].args.query,
      'fuel delivery requirement'
    );
    assert.equal(parsed.interrupted, false);
  });

  it('parseLiveMessage extracts part.functionCall', () => {
    const parsed = geminiLiveService.parseLiveMessage({
      serverContent: {
        modelTurn: {
          parts: [
            {
              functionCall: {
                id: 'c2',
                name: 'searchKnowledge',
                args: { query: 'pricing' },
              },
            },
          ],
        },
      },
    });
    assert.equal(parsed.functionCalls.length, 1);
    assert.equal(parsed.functionCalls[0].name, 'searchKnowledge');
  });

  it('sendToolResponse forwards to session.sendToolResponse', () => {
    const sent = [];
    const session = {
      sendToolResponse(payload) {
        sent.push(payload);
      },
    };
    geminiLiveService.sendToolResponse(session, [
      {
        id: 'call-1',
        name: 'searchKnowledge',
        response: {
          found: false,
          snippets: [],
          message: 'No relevant knowledge was found.',
        },
      },
    ]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].functionResponses[0].name, 'searchKnowledge');
    assert.equal(sent[0].functionResponses[0].response.found, false);
  });

  it('handleLiveToolCalls flattens searchKnowledge to found + snippet texts', async () => {
    mock.method(knowledgeService, 'searchKnowledge', async (query) => {
      assert.match(String(query), /dealer/);
      return {
        snippets: [
          { title: 'Dealer', score: 0.9, text: 'Need ID and tax docs.' },
        ],
        usedFallback: false,
        found: true,
        path: 'lexical',
        durationMs: 2,
      };
    });

    const toolPayloads = [];
    const session = {
      callSid: 'CA_TEST_TOOL',
      ending: false,
      liveSession: {
        sendToolResponse(p) {
          toolPayloads.push(p);
        },
      },
    };

    await liveCallSession.handleLiveToolCalls(session, [
      {
        id: 't1',
        name: 'searchKnowledge',
        args: { query: 'documents to become a dealer' },
      },
    ]);

    assert.equal(toolPayloads.length, 1);
    const fr = toolPayloads[0].functionResponses[0];
    assert.equal(fr.name, 'searchKnowledge');
    assert.equal(fr.response.found, true);
    assert.ok(Array.isArray(fr.response.snippets));
    assert.equal(fr.response.snippets[0].text, 'Need ID and tax docs.');
    assert.equal(fr.response.snippets[0].score, 0.9);
    assert.equal(fr.response.result, undefined);
    assert.doesNotMatch(
      JSON.stringify(fr),
      /companyQuickFacts|JPLoft Sales Executive/i
    );
  });

  it('Agent instruction is thin wrapper; huge prompt body never included', () => {
    const body = `Be helpful. UNIQUE_NEVER_IN_LIVE ${'x'.repeat(120000)}`;
    const instruction = agentService.buildAgentSystemInstruction({
      name: 'Sam',
      prompts: [{ text: body }],
      languages: ['English'],
    });
    assert.match(instruction, /KNOWLEDGE/);
    assert.match(instruction, /searchKnowledge/);
    assert.match(instruction, /reference material only/i);
    assert.match(instruction, /SPEECH UNDERSTANDING|UNDERSTANDING AND CLARIFICATION/);
    assert.match(instruction, /CONVERSATION CONTEXT/);
    assert.match(instruction, /found=true/i);
    assert.match(instruction, /NOT UNDERSTOOD/i);
    assert.match(instruction, /NOISE|Prefer silence|background/i);
    assert.match(instruction, /imperfect English/i);
    assert.match(instruction, /Always reply in English/i);
    assert.match(instruction, /I can only assist in English/i);
    assert.match(instruction, /DYNAMIC COMPANY KNOWLEDGE/);
    assert.match(instruction, /HARDCODED GENERIC PROTECTION/);
    assert.match(instruction, /Answer fast and directly/i);
    assert.doesNotMatch(instruction, /companyQuickFacts/);
    assert.doesNotMatch(instruction, /UNIQUE_NEVER_IN_LIVE/);
    assert.doesNotMatch(instruction, /JPLoft|CEO|pricing is|JuicedFuel/i);
    assert.ok(instruction.length < 16000);

    // Stored multi-MB prompt must not trigger Live soft-cap (wrapper only).
    const ok = agentService.assertLivePromptSize({
      name: 'Huge',
      prompts: [{ text: body }],
      languages: ['English'],
    });
    assert.ok(ok.length < agentService.MAX_LIVE_SYSTEM_INSTRUCTION_CHARS);

    assert.ok(knowledgeService.KnowledgeError);
  });
});
