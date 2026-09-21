'use strict';

const callService = require('../services/callService');
const conversationService = require('../services/conversationService');
const twilioVoiceService = require('../services/twilioVoiceService');
const agentService = require('../services/agentService');
const dashboardSocket = require('../websocket/dashboardSocket');
const { getDatabaseStatus } = require('../config/database');
const { env, getOutboundVoiceWebhookUrl } = require('../config/env');
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

async function startOutboundCall(req, res) {
  try {
    const phoneNumber = req.body && req.body.phoneNumber;
    let to;
    try {
      to = twilioVoiceService.normalizeAndValidateE164(phoneNumber);
    } catch (error) {
      return res.status(error.status || 400).json({
        error: error.message,
        code: error.code || 'INVALID_PHONE',
      });
    }

    const twimlUrl = getOutboundVoiceWebhookUrl();
    if (!twimlUrl) {
      return res.status(503).json({
        error: 'PUBLIC_BASE_URL is not configured for outbound TwiML',
        code: 'TWIML_URL_MISSING',
      });
    }
    if (!env.mediaStreamWsUrl && !env.publicBaseUrl) {
      return res.status(503).json({
        error: 'MEDIA_STREAM_WS_URL / PUBLIC_BASE_URL not configured',
        code: 'MEDIA_STREAM_MISSING',
      });
    }

    let agentResolved;
    try {
      agentResolved = await agentService.requireAgentForCall();
    } catch (error) {
      return res.status(error.status || 400).json({
        error: error.message || 'Agent configuration invalid',
        code: error.code || 'AGENT_CONFIG_ERROR',
      });
    }

    const created = await twilioVoiceService.createOutboundCall({
      to,
      twimlUrl,
    });

    if (!callService.isValidTwilioCallSid(created.callSid)) {
      return res.status(502).json({
        error: 'Twilio returned an invalid CallSid',
        code: 'INVALID_CALL_SID',
      });
    }

    await callService.createCall({
      callSid: created.callSid,
      from: created.from,
      to: created.to,
      status: 'incoming',
      direction: 'outbound',
      agentId: agentResolved.agentId,
    });

    dashboardSocket.broadcast({
      type: 'CALL_OUTBOUND_STARTED',
      data: {
        callSid: created.callSid,
        from: created.from,
        to: created.to,
        status: created.status,
        direction: 'outbound',
        agentId: String(agentResolved.agentId),
        agentName: agentResolved.agentName,
      },
    });

    return res.status(201).json({
      callSid: created.callSid,
      status: created.status,
      to: created.to,
      from: created.from,
      direction: 'outbound',
      agentId: String(agentResolved.agentId),
      agentName: agentResolved.agentName,
    });
  } catch (error) {
    logger.error('API', `startOutboundCall failed: ${error.message}`);
    return res.status(error.status || 502).json({
      error: error.message || 'Failed to start outbound call',
      code: error.code || 'OUTBOUND_FAILED',
    });
  }
}

async function hangupOutboundCall(req, res) {
  try {
    const { callSid } = req.params;
    const result = await twilioVoiceService.hangupCall(callSid);
    await callService.markCompleted(callSid);
    dashboardSocket.broadcast({
      type: 'CALL_COMPLETED',
      data: {
        callSid,
        status: 'completed',
        direction: 'outbound',
      },
    });
    return res.json(result);
  } catch (error) {
    logger.error('API', `hangupOutboundCall failed: ${error.message}`);
    return res.status(error.status || 502).json({
      error: error.message || 'Failed to hang up call',
      code: error.code || 'HANGUP_FAILED',
    });
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
  startOutboundCall,
  hangupOutboundCall,
};
