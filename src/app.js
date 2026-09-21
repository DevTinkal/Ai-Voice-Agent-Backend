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
  // Allow any frontend origin (Vercel, EC2, localhost, future domains).
  app.use(cors());

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
