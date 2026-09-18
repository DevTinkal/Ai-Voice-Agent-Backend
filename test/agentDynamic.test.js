'use strict';

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createApp } = require('../src/app');
const agentService = require('../src/services/agentService');
const knowledgeService = require('../src/services/knowledgeService');
const {
  buildSystemInstruction,
  buildGreetingInstruction,
} = require('../src/config/prompts');
const { buildLiveConfig } = require('../src/services/geminiLiveService');
const callService = require('../src/services/callService');
const twilioVoiceService = require('../src/services/twilioVoiceService');
const dashboardSocket = require('../src/websocket/dashboardSocket');
const { env } = require('../src/config/env');

function request(server, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload =
      body == null
        ? null
        : typeof body === 'string'
          ? body
          : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.address().port,
        method,
        path,
        headers: {
          ...(payload
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
              }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, text, json });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeAgentDoc({
  name = 'Voice Bot',
  status = 'active',
  prompts = [],
  languages = ['English'],
} = {}) {
  const promptDocs = prompts.map((text, i) => ({
    _id: { toString: () => `p${i}` },
    text,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  const doc = {
    _id: { toString: () => 'a1' },
    name,
    status,
    languages,
    prompts: promptDocs,
    createdAt: new Date(),
    updatedAt: new Date(),
    toObject() {
      return {
        _id: this._id,
        name: this.name,
        status: this.status,
        languages: this.languages,
        prompts: this.prompts,
        createdAt: this.createdAt,
        updatedAt: this.updatedAt,
      };
    },
    async save() {
      return this;
    },
  };
  doc.prompts.id = (id) =>
    doc.prompts.find((p) => String(p._id) === String(id)) || null;
  for (const p of doc.prompts) {
    p.deleteOne = function deleteOne() {
      const idx = doc.prompts.indexOf(this);
      if (idx >= 0) doc.prompts.splice(idx, 1);
    };
  }
  return doc;
}

describe('singleton Agent + Live thin wrapper', () => {
  it('combinePrompts preserves order and does not truncate', () => {
    const long = 'X'.repeat(5000);
    const combined = agentService.combinePrompts({
      prompts: [{ text: 'First block' }, { text: long }, { text: 'Third' }],
    });
    assert.equal(combined.startsWith('First block\n\n'), true);
    assert.equal(combined.includes(long), true);
    assert.equal(combined.endsWith('\n\nThird'), true);
  });

  it('Live systemInstruction is thin — no prompt body / no Parker', () => {
    const marker = 'SECRET_PROMPT_BODY_MARKER_abc123';
    const joined = agentService.buildAgentSystemInstruction({
      name: 'smith',
      prompts: [
        { text: `${marker} Prompt one: be helpful.` },
        { text: 'Prompt two: stay concise.' },
      ],
      languages: ['English', 'Hindi'],
    });
    assert.match(joined, /AGENT IDENTITY/);
    assert.match(joined, /spoken name on this call is smith/);
    assert.match(joined, /say you are smith/i);
    assert.doesNotMatch(joined, /\{chatbotName\}/);
    assert.doesNotMatch(joined, new RegExp(marker));
    assert.doesNotMatch(joined, /Prompt one: be helpful/);
    assert.doesNotMatch(joined, /Prompt two: stay concise/);
    assert.match(joined, /LANGUAGE POLICY/);
    assert.match(joined, /searchKnowledge/);
    assert.match(joined, /English, Hindi/);
    assert.match(joined, /reply in English by default/i);

    const live = buildLiveConfig({ systemInstruction: joined, midCall: false });
    assert.doesNotMatch(String(live.systemInstruction), new RegExp(marker));
    assert.match(String(live.systemInstruction), /smith/);
    assert.ok(live.tools && live.tools[0] && live.tools[0].functionDeclarations);
    assert.equal(
      live.tools[0].functionDeclarations[0].name,
      'searchKnowledge'
    );
    assert.doesNotMatch(String(live.systemInstruction), /Parker/i);

    const greet = buildGreetingInstruction();
    assert.doesNotMatch(greet, /Parker|JPLoft/i);

    const tech = buildSystemInstruction(joined);
    assert.doesNotMatch(tech, /Parker/i);
  });

  it('normalizeLanguages parses comma list and defaults English', () => {
    assert.deepEqual(agentService.normalizeLanguages('Hindi, Spanish'), [
      'English',
      'Hindi',
      'Spanish',
    ]);
    assert.deepEqual(agentService.normalizeLanguages(['english', 'Hindi']), [
      'English',
      'Hindi',
    ]);
    assert.deepEqual(agentService.normalizeLanguages(''), ['English']);
  });

  it('requireAgentForCall fails closed; large prompt OK; empty blocked', async () => {
    const original = agentService.getSingletonAgent;

    agentService.getSingletonAgent = async () => null;
    await assert.rejects(
      () => agentService.requireAgentForCall(),
      (err) => err.code === 'AGENT_NOT_FOUND'
    );

    agentService.getSingletonAgent = async () =>
      makeAgentDoc({ status: 'disabled', prompts: ['x'] });
    await assert.rejects(
      () => agentService.requireAgentForCall(),
      (err) => err.code === 'AGENT_DISABLED'
    );

    agentService.getSingletonAgent = async () =>
      makeAgentDoc({ status: 'active', prompts: [] });
    await assert.rejects(
      () => agentService.requireAgentForCall(),
      (err) => err.code === 'AGENT_NO_PROMPTS'
    );

    agentService.getSingletonAgent = async () =>
      makeAgentDoc({
        name: 'Ready',
        status: 'active',
        prompts: ['Alpha', 'Beta'],
      });
    const ok = await agentService.requireAgentForCall();
    assert.equal(ok.agentName, 'Ready');
    assert.match(ok.systemInstruction, /AGENT IDENTITY/);
    assert.match(ok.systemInstruction, /spoken name on this call is Ready/);
    assert.doesNotMatch(ok.systemInstruction, /Alpha/);
    assert.doesNotMatch(ok.systemInstruction, /Beta/);
    assert.match(ok.systemInstruction, /LANGUAGE POLICY/);
    assert.match(ok.systemInstruction, /searchKnowledge/);
    assert.match(ok.systemInstruction, /English/);

    agentService.getSingletonAgent = async () =>
      makeAgentDoc({
        name: 'Huge',
        status: 'active',
        prompts: [
          'x'.repeat(agentService.MAX_LIVE_SYSTEM_INSTRUCTION_CHARS + 50000),
        ],
      });
    const hugeOk = await agentService.requireAgentForCall();
    assert.equal(hugeOk.agentName, 'Huge');
    assert.ok(
      hugeOk.systemInstruction.length <
        agentService.MAX_LIVE_SYSTEM_INSTRUCTION_CHARS
    );

    agentService.getSingletonAgent = original;
  });
});

describe('Agent API routes (mocked service)', () => {
  let server;
  let store;

  before(async () => {
    store = null;

    mock.method(agentService, 'getSingletonAgent', async () => store);
    mock.method(agentService, 'createAgent', async ({ name }) => {
      if (store) {
        throw new agentService.AgentConfigError(
          'Agent already exists',
          409,
          'AGENT_ALREADY_EXISTS'
        );
      }
      store = makeAgentDoc({ name: String(name).trim(), prompts: [] });
      return store;
    });
    mock.method(agentService, 'updateAgent', async ({ name, status, prompt }) => {
      if (!store) {
        throw new agentService.AgentConfigError(
          'Agent configuration not found',
          404,
          'AGENT_NOT_FOUND'
        );
      }
      if (name !== undefined) store.name = String(name).trim();
      if (status !== undefined) store.status = status;
      if (prompt !== undefined) {
        const trimmed = String(prompt || '').trim();
        if (!trimmed) {
          throw new agentService.AgentConfigError(
            'Prompt text is required',
            400,
            'PROMPT_REQUIRED'
          );
        }
        store.prompts = [
          {
            _id: { toString: () => 'p0' },
            text: trimmed,
            createdAt: new Date(),
            updatedAt: new Date(),
            deleteOne() {
              store.prompts = [];
            },
          },
        ];
        store.prompts.id = (id) =>
          store.prompts.find((x) => String(x._id) === String(id)) || null;
      }
      return store;
    });
    mock.method(agentService, 'addPrompt', async (text) =>
      agentService.updateAgent({ prompt: text })
    );
    mock.method(agentService, 'updatePrompt', async (_id, text) =>
      agentService.updateAgent({ prompt: text })
    );
    mock.method(agentService, 'deletePrompt', async (promptId) => {
      if (!store) {
        throw new agentService.AgentConfigError(
          'Agent configuration not found',
          404,
          'AGENT_NOT_FOUND'
        );
      }
      const prompt = store.prompts.id(promptId);
      if (!prompt) {
        throw new agentService.AgentConfigError(
          'Prompt not found',
          404,
          'PROMPT_NOT_FOUND'
        );
      }
      prompt.deleteOne();
      return store;
    });
    mock.method(knowledgeService, 'getStatus', async () => ({
      status: 'ready',
      charCount: 100,
      chunkCount: 2,
      filePath: null,
      error: null,
    }));

    server = http.createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    mock.restoreAll();
    await new Promise((resolve) => server.close(resolve));
  });

  it('CRUD via /api/agent — single prompt replace', async () => {
    let res = await request(server, 'GET', '/api/agent');
    assert.equal(res.status, 404);

    res = await request(server, 'POST', '/api/agent', { name: '  Voice Bot  ' });
    assert.equal(res.status, 201);
    assert.equal(res.json.agent.name, 'Voice Bot');
    assert.deepEqual(res.json.agent.prompts, []);

    res = await request(server, 'POST', '/api/agent', { name: 'Other' });
    assert.equal(res.status, 409);

    res = await request(server, 'PATCH', '/api/agent', {
      name: 'Voice Bot Pro',
      prompt: 'First full prompt',
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.agent.name, 'Voice Bot Pro');
    assert.equal(res.json.agent.prompt, 'First full prompt');
    assert.equal(res.json.agent.prompts.length, 1);

    const long = `Long ${'Y'.repeat(4000)}`;
    res = await request(server, 'PATCH', '/api/agent', { prompt: long });
    assert.equal(res.status, 200);
    assert.equal(res.json.agent.prompts.length, 1);
    assert.equal(res.json.agent.prompt, long);

    res = await request(server, 'POST', '/api/agent/prompts', {
      text: 'Replaced via legacy',
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.agent.prompts.length, 1);
    assert.equal(res.json.agent.prompt, 'Replaced via legacy');
  });

  it('knowledge CRUD returns 405; status works', async () => {
    let res = await request(server, 'GET', '/api/knowledge/status');
    assert.equal(res.status, 200);
    assert.equal(res.json.knowledge.status, 'ready');

    res = await request(server, 'POST', '/api/knowledge', {
      title: 'x',
      text: 'y',
    });
    assert.equal(res.status, 405);
  });
});

describe('outbound fails closed without valid agent', () => {
  let server;
  let prevPublic;
  let prevMedia;
  let prevFrom;
  let createCalls;

  before(async () => {
    prevPublic = env.publicBaseUrl;
    prevMedia = env.mediaStreamWsUrl;
    prevFrom = env.twilioPhoneNumber;
    env.publicBaseUrl = 'https://example.test';
    env.mediaStreamWsUrl = 'wss://example.test/media-stream';
    env.twilioPhoneNumber = '+15551234567';
    createCalls = 0;

    mock.method(dashboardSocket, 'broadcast', () => {});
    mock.method(twilioVoiceService, 'createOutboundCall', async ({ to }) => {
      createCalls += 1;
      return {
        callSid: 'CAfailclosed',
        status: 'queued',
        to,
        from: env.twilioPhoneNumber,
        direction: 'outbound',
      };
    });
    mock.method(callService, 'createCall', async (data) => data);

    server = http.createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    env.publicBaseUrl = prevPublic;
    env.mediaStreamWsUrl = prevMedia;
    env.twilioPhoneNumber = prevFrom;
    mock.restoreAll();
    await new Promise((resolve) => server.close(resolve));
  });

  it('returns 400 and does not create Twilio call when agent disabled', async () => {
    mock.method(agentService, 'requireAgentForCall', async () => {
      throw new agentService.AgentConfigError(
        'Agent is disabled',
        400,
        'AGENT_DISABLED'
      );
    });

    const res = await request(server, 'POST', '/api/outbound-call', {
      phoneNumber: '+919876543210',
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'AGENT_DISABLED');
    assert.equal(createCalls, 0);
  });
});
