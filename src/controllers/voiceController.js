'use strict';

const twilio = require('twilio');
const {
  env,
  getVoiceWebhookUrl,
  getOutboundVoiceWebhookUrl,
  getOutboundGreetingPlayUrl,
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
 * Connect + Stream TwiML, optionally preceded by answer-gated greeting `<Play>`.
 * @param {string} from
 * @param {string} to
 * @param {{ playUrl?: string }} [opts]
 */
function buildMediaStreamTwiml(from, to, opts = {}) {
  const mediaUrl = getMediaStreamWsUrl();
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  if (!mediaUrl) {
    response.say(
      'We are sorry. The voice assistant is temporarily unavailable.'
    );
    return { xml: response.toString(), ok: false };
  }

  const playUrl = opts.playUrl ? String(opts.playUrl).trim() : '';
  if (playUrl) {
    response.play(playUrl);
  }

  const connect = response.connect();
  const stream = connect.stream({
    url: mediaUrl,
  });
  stream.parameter({ name: 'from', value: from || '' });
  stream.parameter({ name: 'to', value: to || '' });
  return { xml: response.toString(), ok: true, playUrl: playUrl || null };
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
 * TwiML webhook for outbound calls AFTER the callee answers.
 * Playback gate: only here may the buffered greeting become audible.
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

    let playUrl = null;
    // If Gemini finished (or nearly finished) buffering during ring, assemble clip now.
    const primedSession = liveCallSession.getSession(callSid);
    if (primedSession) {
      liveCallSession.maybeFinalizeOutboundGreetingClip(primedSession);
    }
    if (liveCallSession.hasOutboundGreetingClip(callSid)) {
      const authorized = liveCallSession.authorizeOutboundGreetingPlay(callSid);
      if (authorized) {
        playUrl = getOutboundGreetingPlayUrl(callSid);
        liveCallSession.stampFirstResponse(callSid, 'greeting_play_twiml');
      }
    }

    if (!playUrl) {
      logger.info(
        'OUTBOUND_GREETING',
        `[OUTBOUND_GREETING] state=ANSWERED action=FALLBACK callSid=${callSid}`
      );
    }

    const built = buildMediaStreamTwiml(from, to, { playUrl });
    if (!built.ok) {
      logger.error('TWILIO', 'MEDIA_STREAM_WS_URL is not configured');
      res.type('text/xml');
      return res.status(200).send(built.xml);
    }

    liveCallSession.stampFirstResponse(callSid, 'twiml_sent');
    res.type('text/xml');
    res.status(200).send(built.xml);

    // Background: DB upsert + dashboard + answer-time prime FALLBACK (no-op if dial primed).
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
      .primeOutboundLive(callSid, { from, to, agentId, atDial: false })
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

/**
 * Serve answer-gated greeting WAV for Twilio `<Play>` (never during RINGING).
 */
function handleOutboundGreetingClip(req, res) {
  const callSid = req.params.callSid;
  if (!callService.isValidTwilioCallSid(callSid)) {
    return res.status(404).end();
  }
  const clip = liveCallSession.consumeOutboundGreetingClip(callSid);
  if (!clip) {
    logger.warn(
      'OUTBOUND_GREETING',
      `[OUTBOUND_GREETING] state=ANSWERED action=CLIP_MISSING callSid=${callSid}`
    );
    return res.status(404).end();
  }
  res.set({
    'Content-Type': 'audio/wav',
    'Content-Length': clip.length,
    'Cache-Control': 'no-store',
  });
  return res.status(200).send(clip);
}

/**
 * Twilio status callback — teardown dial prime if call never reached Media Stream.
 */
async function handleOutboundStatus(req, res) {
  try {
    const callSid = req.body.CallSid;
    const callStatus = String(req.body.CallStatus || '').toLowerCase();
    res.status(204).end();

    if (!callService.isValidTwilioCallSid(callSid)) {
      return;
    }

    if (
      callStatus === 'completed' ||
      callStatus === 'busy' ||
      callStatus === 'no-answer' ||
      callStatus === 'canceled' ||
      callStatus === 'failed'
    ) {
      const session = liveCallSession.getSession(callSid);
      if (session && !session.streamSid && !session.twilioWs) {
        logger.info(
          'OUTBOUND_GREETING',
          `[OUTBOUND_GREETING] state=RINGING action=TEARDOWN callSid=${callSid} status=${callStatus}`
        );
        await liveCallSession.endLiveCall(callSid, 'no_answer').catch(() => {});
      }
    }
  } catch (error) {
    logger.warn('TWILIO', `outbound status callback: ${error.message}`);
  }
}

module.exports = {
  handleIncomingCall,
  handleOutboundTwiml,
  handleOutboundGreetingClip,
  handleOutboundStatus,
  validateTwilioRequest,
  buildMediaStreamTwiml,
};
