'use strict';

const { WebSocketServer } = require('ws');
const twilio = require('twilio');
const { env } = require('../config/env');
const conversationService = require('../services/conversationService');
const logger = require('../utils/logger');

/** @type {import('ws').WebSocketServer | null} */
let wss = null;

function validateConversationRelaySignature(request) {
  // Local demos / tunnels often need this while wiring credentials.
  if (env.skipTwilioSignature) {
    logger.warn('WS', 'Skipping Twilio WS signature validation (SKIP_TWILIO_SIGNATURE)');
    return true;
  }

  if (!env.twilioAuthToken) {
    if (env.nodeEnv === 'development') {
      logger.warn(
        'WS',
        'TWILIO_AUTH_TOKEN missing — allowing ConversationRelay in development'
      );
      return true;
    }
    logger.error('WS', 'TWILIO_AUTH_TOKEN missing — rejecting WS connection');
    return false;
  }

  const signature =
    request.headers['x-twilio-signature'] ||
    request.headers['X-Twilio-Signature'];

  if (!signature) {
    logger.warn('WS', 'Missing X-Twilio-Signature on ConversationRelay connect');
    return false;
  }

  const url =
    env.conversationRelayWsUrl ||
    (env.publicBaseUrl
      ? `${env.publicBaseUrl
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:')
        .replace(/\/$/, '')}/conversation-relay`
      : '');

  if (!url) {
    logger.error('WS', 'CONVERSATION_RELAY_WS_URL not configured');
    return false;
  }

  // Signature must be validated against the exact wss:// URL configured in TwiML.
  const valid = twilio.validateRequest(
    env.twilioAuthToken,
    signature,
    url,
    {}
  );

  if (!valid) {
    logger.warn('WS', 'Invalid Twilio ConversationRelay signature');
  }

  return valid;
}

function attachConversationRelay(server) {
  wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    logger.info('WS', 'ConversationRelay connected');

    ws.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        logger.warn('WS', 'Malformed JSON from ConversationRelay');
        return;
      }

      if (!message || typeof message.type !== 'string') {
        logger.warn('WS', 'Invalid ConversationRelay message shape');
        return;
      }

      try {
        switch (message.type) {
          case 'setup':
            await conversationService.handleSetup(ws, message);
            break;
          case 'prompt':
            await conversationService.handlePrompt(ws, message);
            break;
          case 'interrupt':
            await conversationService.handleInterrupt(ws, message);
            break;
          case 'error':
            await conversationService.handleError(ws, message);
            break;
          case 'dtmf':
            logger.info('WS', `DTMF digit received: ${message.digit || '?'}`);
            break;
          default:
            logger.warn('WS', `Unknown message type: ${message.type}`);
        }
      } catch (error) {
        logger.error('WS', `Handler error: ${error.message}`);
        try {
          conversationService.sendTextToRelay(
            ws,
            "I'm sorry, I'm having trouble processing that right now. Could you please try again?",
            true
          );
        } catch {
          // ignore
        }
      }
    });

    ws.on('close', async () => {
      try {
        await conversationService.handleClose(ws);
      } catch (error) {
        logger.error('WS', `Close handler error: ${error.message}`);
      }
    });

    ws.on('error', (error) => {
      logger.error('WS', `ConversationRelay socket error: ${error.message}`);
    });
  });

  return wss;
}

function handleUpgrade(request, socket, head) {
  if (!wss) {
    socket.destroy();
    return;
  }

  if (!validateConversationRelaySignature(request)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
}

function closeConversationRelay() {
  if (wss) {
    for (const client of wss.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    wss.close();
    wss = null;
  }
  conversationService.clearAllSessions();
}

module.exports = {
  attachConversationRelay,
  handleUpgrade,
  closeConversationRelay,
  validateConversationRelaySignature,
};
