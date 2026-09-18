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
    assert.doesNotMatch(instruction, /UNIQUE_FDD_MARKER_NEVER_IN_WRAPPER/);
    assert.doesNotMatch(instruction, /franchise territory royalty/);
    assert.ok(instruction.length < 5000);
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
