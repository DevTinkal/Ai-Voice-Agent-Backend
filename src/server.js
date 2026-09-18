'use strict';

const http = require('http');
const { URL } = require('url');
const { createApp } = require('./app');
const { env } = require('./config/env');
const {
  connectDatabase,
  disconnectDatabase,
} = require('./config/database');
const mediaStream = require('./websocket/mediaStream');
const conversationRelay = require('./websocket/conversationRelay');
const dashboardSocket = require('./websocket/dashboardSocket');
const logger = require('./utils/logger');

async function start() {
  const app = createApp();
  const server = http.createServer(app);

  mediaStream.attachMediaStream(server);
  // ConversationRelay kept attached only for explicit deprecation responses.
  conversationRelay.attachConversationRelay(server);
  dashboardSocket.attachDashboardSocket(server);

  server.on('upgrade', (request, socket, head) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;

      if (pathname === '/media-stream') {
        mediaStream.handleUpgrade(request, socket, head);
        return;
      }

      if (pathname === '/conversation-relay') {
        logger.warn(
          'WS',
          'Deprecated /conversation-relay hit — phone path is Gemini Live Media Streams'
        );
        conversationRelay.handleUpgrade(request, socket, head);
        return;
      }

      if (pathname === '/dashboard') {
        dashboardSocket.handleUpgrade(request, socket, head);
        return;
      }

      socket.destroy();
    } catch (error) {
      logger.error('WS', `Upgrade error: ${error.message}`);
      socket.destroy();
    }
  });

  await connectDatabase();

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        logger.error(
          'SERVER',
          `Port ${env.port} is already in use (EADDRINUSE). Stop the other process and retry.`
        );
      } else {
        logger.error(
          'SERVER',
          `HTTP server listen error: ${error.message}`
        );
      }
      reject(error);
    });

    server.listen(env.port, () => {
      logger.info('SERVER', `HTTP server started on port ${env.port}`);
      logger.info(
        'SERVER',
        `Phone path: Gemini Live + Media Streams (${env.mediaStreamWsUrl || 'MEDIA_STREAM_WS_URL unset'})`
      );
      logger.info(
        'SERVER',
        `VAD env start=${env.vadStartSensitivity} end=${env.vadEndSensitivity} prefixMs=${env.vadPrefixPaddingMs} silenceMs=${env.vadSilenceDurationMs}`
      );
      resolve();
    });
  });

  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('SERVER', `${signal} received — shutting down gracefully`);

    try {
      mediaStream.closeMediaStream();
      conversationRelay.closeConversationRelay();
      dashboardSocket.closeDashboardSocket();

      await new Promise((resolve) => {
        server.close(() => resolve());
      });

      await disconnectDatabase();
      logger.info('SERVER', 'Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('SERVER', `Shutdown error: ${error.message}`);
      process.exit(1);
    }
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', (error) => {
    logger.error('SERVER', `Uncaught exception: ${error.message}`);
  });

  process.on('unhandledRejection', (reason) => {
    const message =
      reason && reason.message ? reason.message : String(reason);
    logger.error('SERVER', `Unhandled rejection: ${message}`);
  });
}

start().catch((error) => {
  logger.error('SERVER', `Failed to start: ${error.message}`);
  process.exit(1);
});
