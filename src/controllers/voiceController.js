'use strict';

const twilio = require('twilio');
const {
  env,
  getVoiceWebhookUrl,
  getOutboundVoiceWebhookUrl,
  getMediaStreamWsUrl,
} = require('../config/env');
const callService = require('../services/callService');
const agentService = require('../services/agentService');
const liveCallSession = require('../services/liveCallSession');
const dashboardSocket = require('../websocket/dashboardSocket');
const logger = require('../utils/logger');

function validateTwilioRequest(req, expectedUrl) {
  if (env.skipTwilioSignature) {
    return true;
  }

  if (!env.twilioAuthToken) {
    if (env.nodeEnv === 'development') {
      logger.warn(
        'TWILIO',
        'TWILIO_AUTH_TOKEN missing — skipping signature validation in development'
      );
      return true;
    }
    return false;
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    return false;
  }

  const url = expectedUrl || getVoiceWebhookUrl();
  if (!url) {
    logger.error('TWILIO', 'PUBLIC_BASE_URL not set — cannot validate signature');
    return env.nodeEnv === 'development';
  }

  return twilio.validateRequest(
    env.twilioAuthToken,
    signature,
    url,
    req.body || {}
  );
}

/**
 * Shared Connect + Stream TwiML used by inbound and outbound answer webhooks.
 */
function buildMediaStreamTwiml(from, to) {
  const mediaUrl = getMediaStreamWsUrl();
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  if (!mediaUrl) {
    response.say(
      'We are sorry. The voice assistant is temporarily unavailable.'
    );
    return { xml: response.toString(), ok: false };
  }

  const connect = response.connect();
  const stream = connect.stream({
    url: mediaUrl,
  });
  stream.parameter({ name: 'from', value: from || '' });
  stream.parameter({ name: 'to', value: to || '' });
  return { xml: response.toString(), ok: true };
}

function buildAgentUnavailableTwiml() {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  response.say(
    'We are sorry. The voice assistant is not configured. Please try again later.'
  );
  response.hangup();
  return response.toString();
}

/**
 * Resolve singleton agent before connecting Media Streams. Fail closed.
 * @returns {Promise<{ ok: true, agentId: import('mongoose').Types.ObjectId } | { ok: false, xml: string }>}
 */
async function resolveAgentOrFailTwiml() {
  try {
    const resolved = await agentService.requireAgentForCall();
    return { ok: true, agentId: resolved.agentId };
  } catch (error) {
    logger.error(
      'TWILIO',
      `Agent unavailable for call: ${error.code || 'AGENT_ERROR'} ${error.message}`
    );
    return { ok: false, xml: buildAgentUnavailableTwiml() };
  }
}

async function handleIncomingCall(req, res) {
  try {
    if (!validateTwilioRequest(req, getVoiceWebhookUrl())) {
      logger.warn('TWILIO', 'Invalid Twilio signature on /voice');
      return res.status(403).send('Forbidden');
    }

    const callSid = req.body.CallSid;
    const from = req.body.From;
    const to = req.body.To;
    const direction = req.body.Direction || 'inbound';

    logger.info('TWILIO', 'Incoming call (Gemini Live + Media Streams)');

    if (!callSid) {
      logger.warn('TWILIO', 'Missing CallSid');
      return res.status(400).send('Bad Request');
    }

    if (!callService.isValidTwilioCallSid(callSid)) {
      logger.warn('TWILIO', `Ignoring non-Twilio CallSid on /voice: ${callSid}`);
      return res.status(400).send('Bad Request');
    }

    const agentGate = await resolveAgentOrFailTwiml();
    if (!agentGate.ok) {
      res.type('text/xml');
      return res.status(200).send(agentGate.xml);
    }

    const built = buildMediaStreamTwiml(from, to);
    if (!built.ok) {
      logger.error('TWILIO', 'MEDIA_STREAM_WS_URL is not configured');
      res.type('text/xml');
      return res.status(200).send(built.xml);
    }

    await callService.createCall({
      callSid,
      from,
      to,
      status: 'incoming',
      direction: direction === 'outbound-api' || direction === 'outbound'
        ? 'outbound'
        : 'inbound',
      agentId: agentGate.agentId,
    });

    dashboardSocket.broadcast({
      type: 'CALL_INCOMING',
      data: {
        callSid,
        from,
        to,
        status: 'incoming',
        direction: 'inbound',
      },
    });

    res.type('text/xml');
    return res.status(200).send(built.xml);
  } catch (error) {
    logger.error('TWILIO', `Incoming call error: ${error.message}`);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say(
      "I'm sorry, something went wrong. Please try calling again later."
    );
    res.type('text/xml');
    return res.status(200).send(response.toString());
  }
}

/**
 * TwiML webhook for outbound calls after the callee answers.
 * Returns Connect+Stream immediately, then primes Gemini greeting in parallel
 * with Media Stream setup so the callee hears the agent ASAP.
 */
async function handleOutboundTwiml(req, res) {
  try {
    if (!validateTwilioRequest(req, getOutboundVoiceWebhookUrl())) {
      logger.warn('TWILIO', 'Invalid Twilio signature on /voice/outbound');
      return res.status(403).send('Forbidden');
    }

    const callSid = req.body.CallSid;
    const from = req.body.From;
    const to = req.body.To;

    logger.info('TWILIO', 'Outbound call answered (Gemini Live + Media Streams)');

    if (!callSid) {
      logger.warn('TWILIO', 'Missing CallSid on outbound TwiML');
      return res.status(400).send('Bad Request');
    }

    if (!callService.isValidTwilioCallSid(callSid)) {
      logger.warn(
        'TWILIO',
        `Ignoring non-Twilio CallSid on /voice/outbound: ${callSid}`
      );
      return res.status(400).send('Bad Request');
    }

    // Instrumentation only: start first-response clock at answer (before Media Stream).
    liveCallSession.beginFirstResponseTimeline(callSid);

    // Prefer agentId already stored at dial time — avoid a second full resolve when possible.
    const existingCall = await callService.getCallBySid(callSid);
    let agentId = existingCall && existingCall.agentId ? existingCall.agentId : null;
    if (!agentId) {
      const agentGate = await resolveAgentOrFailTwiml();
      if (!agentGate.ok) {
        res.type('text/xml');
        return res.status(200).send(agentGate.xml);
      }
      agentId = agentGate.agentId;
    }

    const built = buildMediaStreamTwiml(from, to);
    if (!built.ok) {
      logger.error('TWILIO', 'MEDIA_STREAM_WS_URL is not configured');
      res.type('text/xml');
      return res.status(200).send(built.xml);
    }

    liveCallSession.stampFirstResponse(callSid, 'twiml_sent');
    res.type('text/xml');
    res.status(200).send(built.xml);

    // Background: DB upsert + dashboard + Gemini prime (do not delay TwiML).
    callService
      .createCall({
        callSid,
        from,
        to,
        status: 'incoming',
        direction: 'outbound',
        agentId,
      })
      .catch((error) => {
        logger.warn(
          'TWILIO',
          `outbound createCall background: ${error.message}`
        );
      });

    dashboardSocket.broadcast({
      type: 'CALL_OUTBOUND_ANSWERED',
      data: {
        callSid,
        from,
        to,
        status: 'incoming',
        direction: 'outbound',
      },
    });

    liveCallSession
      .primeOutboundLive(callSid, { from, to, agentId })
      .catch((error) => {
        logger.warn(
          'TWILIO',
          `outbound prime background: ${error.message}`
        );
      });

    return;
  } catch (error) {
    logger.error('TWILIO', `Outbound TwiML error: ${error.message}`);
    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    response.say(
      "I'm sorry, something went wrong. Please try calling again later."
    );
    res.type('text/xml');
    return res.status(200).send(response.toString());
  }
}

module.exports = {
  handleIncomingCall,
  handleOutboundTwiml,
  validateTwilioRequest,
  buildMediaStreamTwiml,
};
