'use strict';

const knowledgeService = require('../services/knowledgeService');
const logger = require('../utils/logger');

function handleKnowledgeError(res, error) {
  const status = error.status || 500;
  const code = error.code || 'KNOWLEDGE_ERROR';
  if (status >= 500) {
    logger.error('KNOWLEDGE', `${code}: ${error.message}`);
  }
  return res.status(status).json({
    error: error.message || 'Knowledge error',
    code,
  });
}

/** Index status for Agent Prompt auto-index badge. */
async function getStatus(req, res) {
  try {
    const status = await knowledgeService.getStatus();
    return res.json({ knowledge: status, success: true });
  } catch (error) {
    return handleKnowledgeError(res, error);
  }
}

function methodNotAllowed(req, res) {
  return res.status(405).json({
    error:
      'Knowledge is indexed automatically from the Agent Prompt on Save. Separate knowledge CRUD is disabled.',
    code: 'KNOWLEDGE_READ_ONLY',
  });
}

module.exports = {
  getStatus,
  methodNotAllowed,
};
