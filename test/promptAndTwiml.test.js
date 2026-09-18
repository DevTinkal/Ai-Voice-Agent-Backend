'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

describe('phone prompt and env wiring', () => {
  it('builds Live instruction from caller-supplied base only (no Parker/JPLoft)', () => {
    const {
      buildSystemInstruction,
      buildGreetingInstruction,
      FALLBACK_SPEECH,
    } = require('../src/config/prompts');

    const base = "You are Acme Voice Bot.\nFollow the caller's language.";
    const instruction = buildSystemInstruction(base, new Date(), 'Asia/Kolkata', {
      midCall: false,
    });
    assert.match(instruction, /Acme Voice Bot/);
    assert.match(instruction, /GEMINI LIVE/i);
    assert.match(instruction, /LANGUAGE POLICY/i);
    assert.doesNotMatch(instruction, /Parker/i);
    assert.doesNotMatch(instruction, /JPLoft/i);
    assert.doesNotMatch(instruction, /Sales Executive/i);

    const mid = buildSystemInstruction(base, new Date(), 'Asia/Kolkata', {
      midCall: true,
    });
    assert.match(mid, /MID-CALL/);
    assert.doesNotMatch(mid, /Parker|JPLoft/i);

    const greet = buildGreetingInstruction();
    assert.match(greet, /configured system instructions/i);
    assert.doesNotMatch(greet, /Parker|JPLoft/i);

    assert.ok(FALLBACK_SPEECH.length > 10);
    assert.doesNotMatch(FALLBACK_SPEECH, /JPLoft/i);
  });

  it('rejects empty base systemInstruction', () => {
    const { buildSystemInstruction } = require('../src/config/prompts');
    assert.throws(() => buildSystemInstruction(''), /required/i);
  });

  it('exposes Live env fields', () => {
    const { env } = require('../src/config/env');
    assert.ok(env.chatbotName);
    assert.ok(env.geminiLiveModel);
    assert.ok(env.geminiLiveVoice);
    assert.ok(env.voiceLanguage);
  });

  it('TwiML uses Connect Stream not ConversationRelay', () => {
    const { env } = require('../src/config/env');
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const connect = response.connect();
    connect.stream({
      url: env.mediaStreamWsUrl || 'wss://example.test/media-stream',
    });
    const xml = response.toString();
    assert.match(xml, /<Stream /);
    assert.match(xml, /media-stream/);
    assert.doesNotMatch(xml, /ConversationRelay/i);
  });

  it('retired txt dumps are archived and not the runtime source', () => {
    const archivePhone = path.join(
      __dirname,
      '../src/prompts/archive/jploft-sales-executive-phone.txt.corrupted-dump.bak'
    );
    const archiveChatbot = path.join(
      __dirname,
      '../src/prompts/archive/jploft-sales-executive.txt.bak'
    );
    const liveTxt = path.join(
      __dirname,
      '../src/prompts/jploft-sales-executive-phone.txt'
    );
    assert.ok(fs.existsSync(archivePhone));
    assert.ok(fs.existsSync(archiveChatbot));
    assert.equal(fs.existsSync(liveTxt), false);

    // Seed-only file may still exist; Live prompts.js must not require it.
    const promptsSrc = fs.readFileSync(
      path.join(__dirname, '../src/config/prompts.js'),
      'utf8'
    );
    assert.doesNotMatch(promptsSrc, /agent\.config/);
    assert.doesNotMatch(promptsSrc, /loadJploftPrompt/);
  });
});
