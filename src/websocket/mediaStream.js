'use strict';

const { WebSocketServer } = require('ws');
const twilio = require('twilio');
const { env, getMediaStreamWsUrl } = require('../config/env');
const liveCallSession = require('../services/liveCallSession');
const logger = require('../utils/logger');

/** @type {import('ws').WebSocketServer | null} */
let wss = null;

function validateMediaStreamSignature(request) {
  if (env.skipTwilioSignature) {
    logger.warn('WS', 'Skipping Twilio Media Stream signature validation (SKIP_TWILIO_SIGNATURE)');
    return true;
  }

  if (!env.twilioAuthToken) {
    if (env.nodeEnv === 'development') {
      logger.warn(
        'WS',
        'TWILIO_AUTH_TOKEN missing — allowing Media Stream in development'
      );
      return true;
    }
    logger.error('WS', 'TWILIO_AUTH_TOKEN missing — rejecting Media Stream');
    return false;
  }

  const signature =
    request.headers['x-twilio-signature'] ||
    request.headers['X-Twilio-Signature'];

  if (!signature) {
    logger.warn('WS', 'Missing X-Twilio-Signature on Media Stream connect');
    return false;
  }

  const url = getMediaStreamWsUrl();
  if (!url) {
    logger.error('WS', 'MEDIA_STREAM_WS_URL not configured');
    return false;
  }

  const valid = twilio.validateRequest(
    env.twilioAuthToken,
    signature,
    url,
    {}
  );

  if (!valid) {
    logger.warn('WS', 'Invalid Twilio Media Stream signature');
  }

  return valid;
}

function attachMediaStream(server) {
  wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    logger.info('WS', 'Twilio Media Stream connected');
    ws.callSid = null;
    ws.streamSid = null;

    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        logger.warn('WS', 'Malformed JSON from Media Stream');
        return;
      }

      const event = message.event;

      try {
        if (event === 'connected') {
          logger.info('WS', 'Media Stream protocol connected');
          return;
        }

        if (event === 'start') {
          const start = message.start || {};
          const callSid = start.callSid || start.call_sid || null;
          const streamSid = start.streamSid || message.streamSid || null;
          const custom = start.customParameters || {};
          const from = custom.from || custom.From || null;
          const to = custom.to || custom.To || null;

          ws.callSid = callSid;
          ws.streamSid = streamSid;

          logger.info(
            'WS',
            `Media Stream start callSid=${callSid} streamSid=${streamSid}`
          );

          try {
            await liveCallSession.startLiveCall({
              twilioWs: ws,
              callSid,
              streamSid,
              from,
              to,
            });
          } catch (error) {
            logger.error(
              'WS',
              `Failed to start Live call: ${error.message}`
            );
            try {
              ws.close();
            } catch {
              // ignore
            }
          }
          return;
        }

        if (event === 'media') {
          const session =
            liveCallSession.getSession(ws.callSid) ||
            liveCallSession.getSessionByWs(ws);
          if (!session) {
            return;
          }
          const payload =
            message.media && message.media.payload
              ? message.media.payload
              : null;
          liveCallSession.forwardTwilioMedia(session, payload);
          return;
        }

        if (event === 'mark') {
          return;
        }

        if (event === 'stop') {
          const callSid =
            ws.callSid ||
            (message.stop && message.stop.callSid) ||
            null;
          logger.info('WS', `Media Stream stop callSid=${callSid || 'unknown'}`);
          if (callSid) {
            await liveCallSession.endLiveCall(callSid, 'stream_stop');
          }
          return;
        }
      } catch (error) {
        logger.error('WS', `Media Stream handler error: ${error.message}`);
      }
    });

    ws.on('close', () => {
      const callSid = ws.callSid;
      logger.info('WS', `Media Stream closed callSid=${callSid || 'unknown'}`);
      if (callSid) {
        liveCallSession.endLiveCall(callSid, 'ws_close').catch(() => {});
      }
    });

    ws.on('error', (error) => {
      logger.error('WS', `Media Stream socket error: ${error.message}`);
    });
  });
}

function handleUpgrade(request, socket, head) {
  if (!wss) {
    socket.destroy();
    return;
  }

  if (!validateMediaStreamSignature(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
}

function closeMediaStream() {
  liveCallSession.closeAllSessions();
  if (wss) {
    try {
      wss.close();
    } catch {
      // ignore
    }
    wss = null;
  }
}

module.exports = {
  attachMediaStream,
  handleUpgrade,
  closeMediaStream,
  validateMediaStreamSignature,
};
