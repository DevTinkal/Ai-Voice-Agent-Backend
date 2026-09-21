'use strict';

const { describe, it, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const knowledgeMemoryIndex = require('../src/services/knowledgeMemoryIndex');
const knowledgeService = require('../src/services/knowledgeService');
const embeddingService = require('../src/services/embeddingService');
const geminiLiveService = require('../src/services/geminiLiveService');
const agentService = require('../src/services/agentService');
const { env } = require('../src/config/env');

describe('knowledgeMemoryIndex — lexical / cache / semantic', () => {
  afterEach(() => {
    mock.restoreAll();
    knowledgeMemoryIndex.clearCache();
    knowledgeMemoryIndex.loadSnapshotForTests([]);
  });

  it('lexical path returns hits without calling generateEmbedding', async () => {
    let embedCalls = 0;
    mock.method(embeddingService, 'generateEmbedding', async () => {
      embedCalls += 1;
      return [1, 0, 0];
    });

    knowledgeMemoryIndex.loadSnapshotForTests([
      {
        title: 'Franchise',
        text: 'The franchise cost is fifty thousand dollars for a standard territory.',
        embedding: [0, 1, 0],
      },
      {
        title: 'Other',
        text: 'Office hours are nine to five Monday through Friday.',
        embedding: [0, 0, 1],
      },
    ]);

    const result = await knowledgeMemoryIndex.searchLocal(
      'What is the franchise cost?',
      { topK: 3, maxChars: 3000 }
    );
    assert.equal(result.path, 'lexical');
    assert.ok(result.snippets.length >= 1);
    assert.match(result.snippets[0].text, /franchise cost/i);
    assert.equal(embedCalls, 0);
  });

  it('weak lexical query falls through to semantic embedding once', async () => {
    let embedCalls = 0;
    mock.method(embeddingService, 'generateEmbedding', async () => {
      embedCalls += 1;
      return [1, 0, 0];
    });

    knowledgeMemoryIndex.loadSnapshotForTests([
      {
        title: 'Fuel',
        text: 'Delivery trucks refill tanks overnight at partner depots.',
        embedding: [1, 0, 0],
      },
      {
        title: 'Noise',
        text: 'Unrelated gardening tips for spring bulbs and mulch.',
        embedding: [0, 1, 0],
      },
    ]);

    // Query tokens unlikely to overlap content strongly enough for threshold.
    const result = await knowledgeMemoryIndex.searchLocal(
      'xyzzy quantum flibbertigibbet',
      { topK: 3, maxChars: 3000 }
    );
    assert.equal(result.path, 'semantic');
    assert.equal(embedCalls, 1);
    assert.ok(result.snippets.length >= 1);
    assert.match(result.snippets[0].text, /Delivery trucks/i);
  });

  it('cache returns same snippets without second embedding on repeat', async () => {
    let embedCalls = 0;
    mock.method(embeddingService, 'generateEmbedding', async () => {
      embedCalls += 1;
      return [1, 0, 0];
    });

    knowledgeMemoryIndex.loadSnapshotForTests([
      {
        title: 'Fuel',
        text: 'Delivery trucks refill tanks overnight at partner depots.',
        embedding: [1, 0, 0],
      },
    ]);

    const q = 'xyzzy quantum flibbertigibbet';
    const first = await knowledgeMemoryIndex.searchLocal(q, {
      topK: 3,
      maxChars: 3000,
    });
    assert.equal(first.path, 'semantic');
    assert.equal(embedCalls, 1);

    const second = await knowledgeMemoryIndex.searchLocal(q, {
      topK: 3,
      maxChars: 3000,
    });
    assert.equal(second.path, 'cache');
    assert.equal(embedCalls, 1);
    assert.deepEqual(second.snippets, first.snippets);
  });

  it('searchKnowledge uses RAM snapshot via knowledgeService', async () => {
    mock.method(embeddingService, 'generateEmbedding', async () => {
      throw new Error('should not embed on lexical hit');
    });
    knowledgeMemoryIndex.loadSnapshotForTests([
      {
        title: 'Territories',
        text: 'Available territories include Phoenix and Tucson metro areas.',
        embedding: [0, 1, 0],
      },
    ]);

    const result = await knowledgeService.searchKnowledge(
      'Which territories are available?',
      { topK: 3, maxChars: 3000 }
    );
    assert.ok(result.snippets.length >= 1);
    assert.match(result.snippets[0].text, /Phoenix/);
    assert.equal(result.path, 'lexical');
  });

  it('searchLocal reports durationMs and candidates on lexical hit', async () => {
    mock.method(embeddingService, 'generateEmbedding', async () => {
      throw new Error('should not embed');
    });
    knowledgeMemoryIndex.loadSnapshotForTests([
      {
        title: 'Cost',
        text: 'The franchise fee and royalty percentages are listed in the FDD.',
        embedding: [0, 1, 0],
      },
    ]);
    const result = await knowledgeMemoryIndex.searchLocal(
      'franchise fee royalty',
      { topK: 3, maxChars: 3000, callSid: 'CA_BENCH' }
    );
    assert.equal(result.path, 'lexical');
    assert.ok(typeof result.durationMs === 'number');
    assert.ok(result.durationMs >= 0);
    assert.ok(typeof result.candidates === 'number');
    assert.ok(result.candidates >= 1);
    assert.ok(result.snippets.length >= 1);
  });

  it('selects at most topK and respects maxChars', async () => {
    knowledgeMemoryIndex.loadSnapshotForTests([
      {
        title: 'A',
        text: 'franchise pricing alpha '.repeat(40),
        embedding: [1, 0],
      },
      {
        title: 'B',
        text: 'franchise pricing beta '.repeat(40),
        embedding: [1, 0],
      },
      {
        title: 'C',
        text: 'franchise pricing gamma '.repeat(40),
        embedding: [1, 0],
      },
      {
        title: 'D',
        text: 'franchise pricing delta '.repeat(40),
        embedding: [1, 0],
      },
    ]);

    const result = await knowledgeMemoryIndex.searchLocal(
      'franchise pricing',
      { topK: 3, maxChars: 500 }
    );
    assert.equal(result.path, 'lexical');
    assert.ok(result.snippets.length <= 3);
    const total = result.snippets.reduce((n, s) => n + s.text.length, 0);
    assert.ok(total <= 500 + 50);
  });
});

describe('Live 3.8 Phase 1 config', () => {
  it('env allows 3.8 default or 3.1 A/B override', () => {
    assert.match(
      env.geminiLiveModel,
      /^gemini-3\.(8-live|1-flash-live-preview)$/
    );
  });

  it('knowledge defaults are topK=3 maxChars=3000', () => {
    assert.equal(env.knowledgeTopK, 3);
    assert.equal(env.knowledgeMaxChars, 3000);
  });

  it('buildLiveConfig declares BLOCKING searchKnowledge and no thinkingConfig', () => {
    const live = geminiLiveService.buildLiveConfig({
      systemInstruction: 'Thin wrapper for tests.',
      midCall: false,
    });
    const decl = live.tools[0].functionDeclarations[0];
    assert.equal(decl.name, 'searchKnowledge');
    assert.equal(decl.behavior, 'BLOCKING');
    assert.equal(Object.prototype.hasOwnProperty.call(live, 'thinkingConfig'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(live, 'thinking_config'), false);
  });
});

describe('Mongo BSON prompt guard', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('rejects prompts larger than MAX_AGENT_PROMPT_MONGO_BYTES', async () => {
    const agentDoc = {
      name: 'Deep',
      status: 'active',
      languages: ['English'],
      prompts: [],
      save: async function save() {
        return this;
      },
    };
    mock.method(agentService, 'getSingletonAgent', async () => agentDoc);

    const huge = 'x'.repeat(agentService.MAX_AGENT_PROMPT_MONGO_BYTES + 100);
    await assert.rejects(
      () => agentService.updateAgent({ prompt: huge }),
      (err) => {
        assert.equal(err.code, 'PROMPT_TOO_LARGE_FOR_MONGO');
        assert.match(err.message, /MongoDB BSON|database storage/i);
        assert.match(err.message, /not a Gemini Live limit/i);
        return true;
      }
    );
  });
});
