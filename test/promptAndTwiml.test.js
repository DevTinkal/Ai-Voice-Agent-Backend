'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const twilio = require('twilio');

describe('phone prompt and env wiring', () => {
  it('loads phone prompt with chatbotName placeholder and no UI chips', () => {
    const {
      loadJploftPrompt,
      buildSystemInstruction,
      PROMPT_FILE_PATH,
      CHATBOT_PROMPT_FILE_PATH,
    } = require('../src/config/prompts');

    assert.ok(fs.existsSync(PROMPT_FILE_PATH));
    assert.ok(fs.existsSync(CHATBOT_PROMPT_FILE_PATH));

    const phone = loadJploftPrompt(true);
    assert.match(phone, /\{chatbotName\}/);
    assert.doesNotMatch(phone, /suggestion chips/i);
    assert.doesNotMatch(phone, /mailto:/i);

    const instruction = buildSystemInstruction(new Date(), 'Asia/Kolkata', {
      chatbotName: 'TestAgent',
      midCall: false,
    });
    assert.match(instruction, /TestAgent/);
    assert.doesNotMatch(instruction, /\{chatbotName\}/);
    assert.match(instruction, /GEMINI LIVE/i);
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

  it('original chatbot prompt file remains on disk untouched as separate file', () => {
    const chatbotPath = path.join(
      __dirname,
      '../src/prompts/jploft-sales-executive.txt'
    );
    const phonePath = path.join(
      __dirname,
      '../src/prompts/jploft-sales-executive-phone.txt'
    );
    assert.ok(fs.existsSync(chatbotPath));
    assert.ok(fs.existsSync(phonePath));
    const chatbot = fs.readFileSync(chatbotPath, 'utf8');
    assert.match(chatbot, /suggestion chips/i);
  });
});
