'use strict';

/**
 * Optional one-time bootstrap: if no Agent document exists, create one with
 * prompts[0] = known-good text from agent.config.js (seed source only).
 * Runtime Live path never re-reads agent.config after this.
 */

const agentService = require('./agentService');
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

  let seedText = '';
  try {
    // Seed-only require — never used on the Live call path after migrate.
    const agentConfig = require('../agent/agent.config');
    seedText = String(agentConfig.systemPrompt || '').trim();
  } catch (error) {
    logger.warn('AGENT', `Seed source unavailable: ${error.message}`);
  }

  if (!seedText) {
    logger.info(
      'AGENT',
      'No Agent document and no seed text — create agent via Admin UI'
    );
    return null;
  }

  // Replace placeholder with a neutral default for continuity; Admin can rename.
  const resolved = seedText.replace(/\{chatbotName\}/g, 'Assistant');

  const agent = await Agent.create({
    name: 'Default Agent',
    status: 'active',
    languages: ['English'],
    prompts: [{ text: resolved }],
  });

  logger.info(
    'AGENT',
    `One-time seed created agent id=${agent._id} prompts=1 (from agent.config seed source)`
  );
  return agentService.serializeAgent(agent);
}

module.exports = {
  migrateOnceIfEmpty,
};
