'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const voiceRoutes = require('./routes/voiceRoutes');
const callRoutes = require('./routes/callRoutes');
const callController = require('./controllers/callController');

function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin) {
          return callback(null, true);
        }
        const allowed =
          /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
          /^http:\/\/192\.168\.\d{1,3}\.\d{1,3}(:\d+)?$/i.test(origin) ||
          /^http:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?$/i.test(origin) ||
          /^http:\/\/172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}(:\d+)?$/i.test(
            origin
          );
        return callback(null, allowed);
      },
    })
  );

  app.use(express.urlencoded({ extended: false, limit: '2mb' }));

  // Large Agent Prompt saves (instructions + company corpus in one field).
  app.use(
    '/api/agent',
    express.json({ limit: '50mb' }),
    require('./routes/agentRoutes')
  );

  app.use(express.json({ limit: '2mb' }));

  app.get('/health', callController.healthCheck);
  app.use('/voice', voiceRoutes);
  app.get('/api/stats', callController.getStats);
  app.post('/api/outbound-call', callController.startOutboundCall);
  app.post(
    '/api/outbound-call/:callSid/hangup',
    callController.hangupOutboundCall
  );
  app.use('/api/calls', callRoutes);
  app.use('/api/knowledge', require('./routes/knowledgeRoutes'));

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, req, res, next) => {
    if (
      err &&
      (err.type === 'entity.too.large' ||
        err.status === 413 ||
        err.statusCode === 413)
    ) {
      return res.status(413).json({
        error:
          'Request body is too large. Agent prompt max ~50MB per request.',
        code: 'PAYLOAD_TOO_LARGE',
      });
    }
    // eslint-disable-next-line no-console
    console.error('[SERVER] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = {
  createApp,
};
