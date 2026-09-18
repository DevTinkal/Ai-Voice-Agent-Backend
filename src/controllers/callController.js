'use strict';

const callService = require('../services/callService');
const conversationService = require('../services/conversationService');
const { getDatabaseStatus } = require('../config/database');
const { env } = require('../config/env');
const logger = require('../utils/logger');

async function listCalls(req, res) {
  try {
    const limit = req.query.limit;
    const calls = await callService.getRecentCalls(limit);
    return res.json({ calls });
  } catch (error) {
    logger.error('API', `listCalls failed: ${error.message}`);
    return res.status(500).json({ error: 'Failed to retrieve calls' });
  }
}

async function getCall(req, res) {
  try {
    const { callSid } = req.params;
    if (!callSid) {
      return res.status(400).json({ error: 'callSid is required' });
    }

    const call = await callService.getCallBySid(callSid);
    if (!call) {
      return res.status(404).json({ error: 'Call not found' });
    }

    const messages = await conversationService.getMessagesForCall(callSid);

    return res.json({
      call,
      messages: messages.map((m) => ({
        callSid: m.callSid,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      })),
    });
  } catch (error) {
    logger.error('API', `getCall failed: ${error.message}`);
    return res.status(500).json({ error: 'Failed to retrieve call' });
  }
}

async function getStats(req, res) {
  try {
    const stats = await callService.getCallStatistics();
    return res.json(stats);
  } catch (error) {
    logger.error('API', `getStats failed: ${error.message}`);
    return res.status(500).json({ error: 'Failed to retrieve stats' });
  }
}

async function probePublicUrl(publicBaseUrl) {
  if (!publicBaseUrl) {
    return { status: 'missing', checkedAt: new Date().toISOString() };
  }

  const healthUrl = `${publicBaseUrl.replace(/\/$/, '')}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    const response = await fetch(healthUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (response.ok) {
      return { status: 'active', checkedAt: new Date().toISOString() };
    }

    return { status: 'expired', checkedAt: new Date().toISOString() };
  } catch {
    clearTimeout(timer);
    return { status: 'expired', checkedAt: new Date().toISOString() };
  }
}

async function healthCheck(req, res) {
  const dbStatus = getDatabaseStatus();
  const healthy = dbStatus === 'connected';
  const publicBaseUrl = env.publicBaseUrl || '';
  const publicLink = await probePublicUrl(publicBaseUrl);

  return res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    service: 'twilio-ai-voice-agent',
    database: dbStatus,
    twilioConfigured: Boolean(
      env.twilioAccountSid && env.twilioAuthToken && env.twilioPhoneNumber
    ),
    twilioPhoneNumber: env.twilioPhoneNumber || null,
    geminiConfigured: Boolean(env.geminiApiKey),
    geminiModel: env.geminiModel || null,
    geminiLiveModel: env.geminiLiveModel || null,
    geminiLiveVoice: env.geminiLiveVoice || null,
    chatbotName: env.chatbotName || null,
    voiceLanguage: env.voiceLanguage || null,
    mediaStreamWsUrl: env.mediaStreamWsUrl || null,
    phoneArchitecture: 'gemini-live-media-streams',
    publicBaseUrl: publicBaseUrl || null,
    publicLinkStatus: publicLink.status,
    publicLinkCheckedAt: publicLink.checkedAt,
  });
}

module.exports = {
  listCalls,
  getCall,
  getStats,
  healthCheck,
};
