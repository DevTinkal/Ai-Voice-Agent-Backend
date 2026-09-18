'use strict';

const { WebSocketServer } = require('ws');
const logger = require('../utils/logger');

/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();

/** @type {import('ws').WebSocketServer | null} */
let wss = null;

function attachDashboardSocket(server) {
  wss = new WebSocketServer({ noServer: true });

  wss.on('connection', (ws) => {
    clients.add(ws);
    logger.info('WS', 'Dashboard client connected');

    ws.send(
      JSON.stringify({
        type: 'SYSTEM_STATUS',
        data: {
          status: 'online',
          service: 'twilio-ai-voice-agent',
        },
      })
    );

    ws.on('message', (raw) => {
      try {
        JSON.parse(raw.toString());
      } catch {
        // Ignore malformed client messages; do not crash.
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info('WS', 'Dashboard client disconnected');
    });

    ws.on('error', (error) => {
      logger.error('WS', `Dashboard socket error: ${error.message}`);
      clients.delete(ws);
    });
  });

  return wss;
}

function handleUpgrade(request, socket, head) {
  if (!wss) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
}

function broadcast(event) {
  if (!event || !event.type) {
    return;
  }

  // Never allow secrets in dashboard payloads.
  const payload = JSON.stringify(event);

  for (const client of clients) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch (error) {
        logger.error('WS', `Dashboard broadcast failed: ${error.message}`);
      }
    }
  }
}

function closeDashboardSocket() {
  for (const client of clients) {
    try {
      client.close();
    } catch {
      // ignore
    }
  }
  clients.clear();

  if (wss) {
    wss.close();
    wss = null;
  }
}

function getConnectedClientCount() {
  return clients.size;
}

module.exports = {
  attachDashboardSocket,
  handleUpgrade,
  broadcast,
  closeDashboardSocket,
  getConnectedClientCount,
};
