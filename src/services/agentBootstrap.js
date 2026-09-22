'use strict';

/**
 * Optional one-time bootstrap: if no Agent exists, do NOT seed hardcoded
 * company prompts. Admin must create/configure via dashboard (full replace on Save).
 */

const { Agent } = require('../models/Agent');
const { isDatabaseConnected } = require('../config/database');
const logger = require('../utils/logger');

async function migrateOnceIfEmpty() {
  if (!isDatabaseConnected()) {
    logger.warn('AGENT', 'Skip seed — database not connected');
    return null;
  }

  const count = await Agent.countDocuments();
  if (count > 0) {
    return null;
  }

  logger.info(
    'AGENT',
    'No Agent document — create and Save Agent Prompt via Admin UI (no hardcoded seed)'
  );
  return null;
}

module.exports = {
  migrateOnceIfEmpty,
};
