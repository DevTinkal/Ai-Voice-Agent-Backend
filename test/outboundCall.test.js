'use strict';

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

const { env } = require('../src/config/env');
const twilioVoiceService = require('../src/services/twilioVoiceService');
const callService = require('../src/services/callService');
const agentService = require('../src/services/agentService');
const liveCallSession = require('../src/services/liveCallSession');
const dashboardSocket = require('../src/websocket/dashboardSocket');
const {
  buildMediaStreamTwiml,
} = require('../src/controllers/voiceController');
const { createApp } = require('../src/app');

function request(server, method, path, body, contentType) {
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
                'Content-Type':
                  contentType || 'application/json',
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
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
          });
        });
      }
    );
    req.on('error', reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

describe('outbound call API and TwiML', () => {
  let server;
  let prevSkip;
  let prevMedia;
  let prevPublic;
  let prevFrom;
  let createCallArgs;
  let broadcastEvents;
  /** When set, createCall awaits this before recording (TwiML must not wait). */
  let createCallHold;

  before(async () => {
    prevSkip = env.skipTwilioSignature;
    prevMedia = env.mediaStreamWsUrl;
    prevPublic = env.publicBaseUrl;
    prevFrom = env.twilioPhoneNumber;

    env.skipTwilioSignature = true;
    env.mediaStreamWsUrl = 'wss://example.test/media-stream';
    env.publicBaseUrl = 'https://example.test';
    env.twilioPhoneNumber = '+15551234567';

    createCallArgs = [];
    broadcastEvents = [];
    createCallHold = null;

    mock.method(callService, 'createCall', async (data) => {
      if (createCallHold) {
        await createCallHold;
      }
      createCallArgs.push(data);
      return data;
    });
    mock.method(callService, 'getCallBySid', async (callSid) => ({
      callSid,
      agentId: '507f1f77bcf86cd799439011',
      status: 'incoming',
      direction: 'outbound',
    }));
    mock.method(callService, 'markCompleted', async (callSid) => ({
      callSid,
      status: 'completed',
    }));
    mock.method(agentService, 'requireAgentForCall', async () => ({
      agentId: '507f1f77bcf86cd799439011',
      agentName: 'Test Agent',
      systemInstruction: 'You are a test agent.',
      agent: { _id: '507f1f77bcf86cd799439011', name: 'Test Agent' },
    }));
    mock.method(liveCallSession, 'primeOutboundLive', async () => null);
    mock.method(liveCallSession, 'beginFirstResponseTimeline', () => {});
    mock.method(liveCallSession, 'stampFirstResponse', () => Date.now());
    mock.method(liveCallSession, 'hasOutboundGreetingClip', () => false);
    mock.method(liveCallSession, 'authorizeOutboundGreetingPlay', () => false);
    mock.method(liveCallSession, 'endLiveCall', async () => null);
    mock.method(dashboardSocket, 'broadcast', (event) => {
      broadcastEvents.push(event);
    });
    mock.method(twilioVoiceService, 'createOutboundCall', async ({ to }) => ({
      callSid: 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      status: 'queued',
      to,
      from: env.twilioPhoneNumber,
      direction: 'outbound',
    }));
    mock.method(twilioVoiceService, 'hangupCall', async (callSid) => ({
      callSid,
      status: 'completed',
    }));

    server = http.createServer(createApp());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    env.skipTwilioSignature = prevSkip;
    env.mediaStreamWsUrl = prevMedia;
    env.publicBaseUrl = prevPublic;
    env.twilioPhoneNumber = prevFrom;
    mock.restoreAll();
    await new Promise((resolve) => server.close(resolve));
  });

  it('rejects non-E.164 phone numbers', async () => {
    const res = await request(server, 'POST', '/api/outbound-call', {
      phoneNumber: 'ddddddddddddddddddd',
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'INVALID_PHONE');
    assert.ok(!JSON.stringify(res.json).includes('authToken'));
  });

  it('accepts Indian 10-digit local and normalizes to +91', async () => {
    createCallArgs.length = 0;
    const res = await request(server, 'POST', '/api/outbound-call', {
      phoneNumber: '9876543210',
    });
    assert.equal(res.status, 201);
    assert.equal(res.json.to, '+919876543210');
    assert.equal(createCallArgs[0].to, '+919876543210');
  });

  it('accepts E.164 and creates outbound Call without secrets', async () => {
    createCallArgs.length = 0;
    broadcastEvents.length = 0;

    const res = await request(server, 'POST', '/api/outbound-call', {
      phoneNumber: '+919876543210',
    });

    assert.equal(res.status, 201);
    assert.equal(res.json.callSid, 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(res.json.direction, 'outbound');
    assert.equal(res.json.to, '+919876543210');
    assert.equal(res.json.from, '+15551234567');
    assert.ok(!('authToken' in res.json));
    assert.ok(!JSON.stringify(res.json).toLowerCase().includes('authtoken'));

    assert.equal(createCallArgs.length, 1);
    assert.equal(createCallArgs[0].direction, 'outbound');
    assert.equal(createCallArgs[0].to, '+919876543210');
    assert.equal(createCallArgs[0].status, 'incoming');

    assert.ok(
      broadcastEvents.some((e) => e.type === 'CALL_OUTBOUND_STARTED')
    );
  });

  it('hangs up via POST /api/outbound-call/:callSid/hangup', async () => {
    const res = await request(
      server,
      'POST',
      '/api/outbound-call/CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/hangup'
    );
    assert.equal(res.status, 200);
    assert.equal(res.json.callSid, 'CAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(res.json.status, 'completed');
  });

  it('buildMediaStreamTwiml includes Connect Stream to media-stream', () => {
    const built = buildMediaStreamTwiml('+15550001111', '+15551234567');
    assert.equal(built.ok, true);
    assert.match(built.xml, /<Connect>/);
    assert.match(built.xml, /<Stream /);
    assert.match(built.xml, /wss:\/\/example\.test\/media-stream/);
    assert.doesNotMatch(built.xml, /ConversationRelay/i);
  });

  it('POST /voice/outbound returns same Media Stream TwiML and stores outbound', async () => {
    createCallArgs.length = 0;
    broadcastEvents.length = 0;

    const body = new URLSearchParams({
      CallSid: 'CAbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      From: '+15551234567',
      To: '+919876543210',
      Direction: 'outbound-api',
    }).toString();

    const res = await request(
      server,
      'POST',
      '/voice/outbound',
      body,
      'application/x-www-form-urlencoded'
    );

    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'] || '', /xml/);
    assert.match(res.text, /<Connect>/);
    assert.match(res.text, /<Stream /);
    assert.match(res.text, /media-stream/);
    assert.doesNotMatch(res.text, /ConversationRelay/i);

    // createCall runs in background after TwiML response
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(createCallArgs.length, 1);
    assert.equal(createCallArgs[0].direction, 'outbound');
    assert.equal(createCallArgs[0].callSid, 'CAbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    assert.ok(
      broadcastEvents.some((e) => e.type === 'CALL_OUTBOUND_ANSWERED')
    );
  });

  it('POST /voice/outbound sends TwiML without awaiting createCall', async () => {
    createCallArgs.length = 0;
    let releaseCreate;
    createCallHold = new Promise((resolve) => {
      releaseCreate = resolve;
    });

    try {
      const body = new URLSearchParams({
        CallSid: 'CAcccccccccccccccccccccccccccccccc',
        From: '+15551234567',
        To: '+919876543210',
        Direction: 'outbound-api',
      }).toString();

      const started = Date.now();
      const res = await request(
        server,
        'POST',
        '/voice/outbound',
        body,
        'application/x-www-form-urlencoded'
      );
      const elapsed = Date.now() - started;

      assert.equal(res.status, 200);
      assert.match(res.text, /<Stream /);
      assert.equal(createCallArgs.length, 0);
      assert.ok(
        elapsed < 500,
        `TwiML should not wait on createCall (elapsed=${elapsed}ms)`
      );

      releaseCreate();
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(createCallArgs.length, 1);
      assert.equal(createCallArgs[0].callSid, 'CAcccccccccccccccccccccccccccccccc');
    } finally {
      createCallHold = null;
    }
  });

  it('POST /voice inbound still returns Connect Stream (unchanged path)', async () => {
    createCallArgs.length = 0;

    const body = new URLSearchParams({
      CallSid: 'CAdddddddddddddddddddddddddddddddd',
      From: '+15550009999',
      To: '+15551234567',
      Direction: 'inbound',
    }).toString();

    const res = await request(
      server,
      'POST',
      '/voice',
      body,
      'application/x-www-form-urlencoded'
    );

    assert.equal(res.status, 200);
    assert.match(res.text, /<Connect>/);
    assert.match(res.text, /<Stream /);
    assert.match(res.text, /media-stream/);
    assert.doesNotMatch(res.text, /ConversationRelay/i);
    assert.equal(createCallArgs[0].direction, 'inbound');
  });

  it('normalizeAndValidateE164 unit cases', () => {
    assert.equal(
      twilioVoiceService.normalizeAndValidateE164('+14155552671'),
      '+14155552671'
    );
    assert.equal(
      twilioVoiceService.normalizeAndValidateE164(' +91 98765-43210 '),
      '+919876543210'
    );
    assert.equal(
      twilioVoiceService.normalizeAndValidateE164('9876543210'),
      '+919876543210'
    );
    assert.equal(
      twilioVoiceService.normalizeAndValidateE164('09876543210'),
      '+919876543210'
    );
    assert.throws(
      () => twilioVoiceService.normalizeAndValidateE164('123'),
      (err) => err.code === 'INVALID_PHONE' && err.status === 400
    );
    assert.throws(
      () => twilioVoiceService.normalizeAndValidateE164('dddddddd'),
      (err) => err.code === 'INVALID_PHONE'
    );
  });
});
