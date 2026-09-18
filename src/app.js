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
      origin: [
        'http://localhost:5173',
        'http://127.0.0.1:5173',
      ],
    })
  );

  // Twilio webhooks send application/x-www-form-urlencoded
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '1mb' }));

  app.get('/health', callController.healthCheck);
  app.use('/voice', voiceRoutes);
  app.get('/api/stats', callController.getStats);
  app.use('/api/calls', callRoutes);

  app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err, req, res, next) => {
    // eslint-disable-next-line no-console
    console.error('[SERVER] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

module.exports = {
  createApp,
};
