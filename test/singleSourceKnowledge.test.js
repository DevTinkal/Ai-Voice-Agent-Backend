'use strict';

const { describe, it, mock, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const knowledgeService = require('../src/services/knowledgeService');
const agentService = require('../src/services/agentService');
const geminiLiveService = require('../src/services/geminiLiveService');

describe('agent prompt as sole knowledge corpus', () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it('updateAgent with prompt replaces prompts to one entry and schedules index', async () => {
    const agentDoc = {
      name: 'Deep',
      status: 'active',
      languages: ['English'],
      prompts: [{ text: 'old one' }, { text: 'old two' }],
      markModified() {},
      save: async function save() {
        return this;
      },
    };
    mock.method(agentService, 'getSingletonAgent', async () => agentDoc);

    let indexed = null;
    mock.method(knowledgeService, 'indexFromAgentPrompt', async (text) => {
      indexed = text;
      return { id: 'doc1', status: 'ready', chunkCount: 1 };
    });

    const huge = `FDD CORPUS ${'Z'.repeat(150000)}`;
    const updated = await agentService.updateAgent({
      name: 'Deep',
      prompt: huge,
    });
    assert.equal(updated.prompts.length, 1);
    assert.equal(updated.prompts[0].text, huge);

    const serialized = agentService.serializeAgent(updated);
    assert.equal(serialized.prompt, huge);

    await new Promise((r) => setImmediate(r));
    assert.equal(indexed, huge);
  });

  it('updateAgent A→B→C leaves only latest prompt text (true replace)', async () => {
    const agentDoc = {
      name: 'Deep',
      status: 'active',
      languages: ['English'],
      prompts: [{ text: 'OLD_TEST_COMPANY_12345' }],
      markModified() {},
      save: async function save() {
        return this;
      },
    };
    mock.method(agentService, 'getSingletonAgent', async () => agentDoc);
    const indexed = [];
    mock.method(knowledgeService, 'indexFromAgentPrompt', async (text) => {
      indexed.push(text);
      return { status: 'ready' };
    });

    await agentService.updateAgent({ prompt: 'OLD_TEST_COMPANY_12345' });
    await agentService.updateAgent({ prompt: 'NEW_TEST_COMPANY_67890' });
    await agentService.updateAgent({ prompt: 'VERSION_C_ONLY_999' });

    assert.equal(agentDoc.prompts.length, 1);
    assert.equal(agentDoc.prompts[0].text, 'VERSION_C_ONLY_999');
    assert.doesNotMatch(agentDoc.prompts[0].text, /OLD_TEST_COMPANY_12345/);
    assert.doesNotMatch(agentDoc.prompts[0].text, /NEW_TEST_COMPANY_67890/);

    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.equal(indexed[indexed.length - 1], 'VERSION_C_ONLY_999');
    assert.ok(!indexed[indexed.length - 1].includes('OLD_TEST_COMPANY_12345'));
  });

  it('prompt save invalidates RAM index so old chunks are not searchable', async () => {
    const knowledgeMemoryIndex = require('../src/services/knowledgeMemoryIndex');
    knowledgeMemoryIndex.loadSnapshotForTests([
      {
        title: 'Old',
        text: 'OLD_TEST_COMPANY_12345 franchise pricing',
        embedding: [1, 0, 0],
      },
    ]);
    assert.equal(knowledgeMemoryIndex.isWarm(), true);

    const agentDoc = {
      name: 'Deep',
      status: 'active',
      languages: ['English'],
      prompts: [{ text: 'OLD_TEST_COMPANY_12345' }],
      markModified() {},
      save: async function save() {
        return this;
      },
    };
    mock.method(agentService, 'getSingletonAgent', async () => agentDoc);
    mock.method(knowledgeService, 'indexFromAgentPrompt', async () => ({
      status: 'ready',
    }));

    await agentService.updateAgent({ prompt: 'NEW_TEST_COMPANY_67890' });
    assert.equal(knowledgeMemoryIndex.isWarm(), false);
  });

  it('buildAgentSystemInstruction is thin — never includes Agent.prompt body', () => {
    const secret =
      'UNIQUE_FDD_MARKER_NEVER_IN_WRAPPER franchise territory royalty 7%';
    const instruction = agentService.buildAgentSystemInstruction({
      name: 'Deep',
      prompts: [{ text: secret }],
      languages: ['English', 'Hindi'],
    });
    assert.match(instruction, /AGENT IDENTITY/);
    assert.match(instruction, /spoken name on this call is Deep/);
    assert.match(instruction, /searchKnowledge/);
    assert.match(instruction, /KNOWLEDGE AND INSTRUCTIONS POLICY|KNOWLEDGE/);
    assert.match(instruction, /SPEECH UNDERSTANDING|UNDERSTANDING AND CLARIFICATION/);
    assert.match(instruction, /CONVERSATION CONTEXT/);
    assert.match(instruction, /LATEST CALLER INTENT WINS|CURRENT USER TURN HAS PRIORITY|new named entity|NEW TOPIC/i);
    assert.match(instruction, /didn't quite catch that|NOT UNDERSTOOD/i);
    assert.match(instruction, /NOISE|Prefer silence|background/i);
    assert.match(instruction, /Opening greeting only|NEVER re-greet/i);
    assert.match(instruction, /DYNAMIC COMPANY KNOWLEDGE/);
    assert.match(instruction, /HARDCODED GENERIC PROTECTION/);
    assert.match(instruction, /always active/i);
    assert.match(instruction, /Do Not Call|opt-out/i);
    assert.match(instruction, /Leadership \/ role questions|founder.*owner.*president|same company/i);
    assert.doesNotMatch(instruction, /UNIQUE_FDD_MARKER_NEVER_IN_WRAPPER/);
    assert.doesNotMatch(instruction, /franchise territory royalty/);
    assert.doesNotMatch(instruction, /JPLoft|CEO|JuicedFuel/i);
    assert.ok(instruction.length < 22000);
  });

  it('large stored prompt does not throw Live size error', () => {
    const huge = 'x'.repeat(250000);
    const agent = {
      name: 'Deep',
      prompts: [{ text: huge }],
      languages: ['English'],
    };
    const instruction = agentService.assertLivePromptSize(agent);
    assert.ok(instruction.length < agentService.MAX_LIVE_SYSTEM_INSTRUCTION_CHARS);
    assert.doesNotMatch(instruction, /xxxx/);
  });

  it('empty prompt blocks calls', async () => {
    mock.method(agentService, 'getSingletonAgent', async () => ({
      name: 'Deep',
      status: 'active',
      prompts: [],
      languages: ['English'],
    }));
    await assert.rejects(
      () => agentService.requireAgentForCall(),
      (err) => err.code === 'AGENT_NO_PROMPTS'
    );
  });

  it('searchKnowledge tool still declared on Live config', () => {
    const live = geminiLiveService.buildLiveConfig({
      systemInstruction: 'Thin behavior prompt only.',
      midCall: false,
    });
    assert.equal(live.tools[0].functionDeclarations[0].name, 'searchKnowledge');
  });

  it('getStatus exposes index fields without requiring company.txt', async () => {
    const status = await knowledgeService.getStatus();
    assert.ok(status);
    assert.equal(Object.prototype.hasOwnProperty.call(status, 'filePath'), true);
    assert.equal(status.filePath, null);
    assert.ok(typeof status.status === 'string');
    assert.ok(typeof status.chunkCount === 'number');
  });
});
