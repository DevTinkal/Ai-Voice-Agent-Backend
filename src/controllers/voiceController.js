'use strict';

const twilio = require('twilio');
const { env, getVoiceWebhookUrl, getMediaStreamWsUrl } = require('../config/env');
const callService = require('../services/callService');
const dashboardSocket = require('../websocket/dashboardSocket');
const logger = require('../utils/logger');

function validateTwilioRequest(req) {
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

  const url = getVoiceWebhookUrl();
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

async function handleIncomingCall(req, res) {
  try {
    if (!validateTwilioRequest(req)) {
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

    const mediaUrl = getMediaStreamWsUrl();
    if (!mediaUrl) {
      logger.error('TWILIO', 'MEDIA_STREAM_WS_URL is not configured');
      const VoiceResponse = twilio.twiml.VoiceResponse;
      const errorResponse = new VoiceResponse();
      errorResponse.say(
        'We are sorry. The voice assistant is temporarily unavailable.'
      );
      res.type('text/xml');
      return res.status(200).send(errorResponse.toString());
    }

    await callService.createCall({
      callSid,
      from,
      to,
      status: 'incoming',
      direction,
    });

    dashboardSocket.broadcast({
      type: 'CALL_INCOMING',
      data: {
        callSid,
        from,
        to,
        status: 'incoming',
      },
    });

    const VoiceResponse = twilio.twiml.VoiceResponse;
    const response = new VoiceResponse();
    const connect = response.connect();
    const stream = connect.stream({
      url: mediaUrl,
    });
    // Custom params appear on Media Stream "start" for session context.
    stream.parameter({ name: 'from', value: from || '' });
    stream.parameter({ name: 'to', value: to || '' });

    res.type('text/xml');
    return res.status(200).send(response.toString());
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

module.exports = {
  handleIncomingCall,
  validateTwilioRequest,
};
