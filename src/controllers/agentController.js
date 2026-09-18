'use strict';

const agentService = require('../services/agentService');
const logger = require('../utils/logger');

function handleAgentError(res, error) {
  const status = error.status || 500;
  const code = error.code || 'AGENT_ERROR';
  if (status >= 500) {
    logger.error('AGENT', `${code}: ${error.message}`);
  }
  return res.status(status).json({
    error: error.message || 'Agent configuration error',
    code,
  });
}

async function getAgent(req, res) {
  try {
    const agent = await agentService.getSingletonAgent();
    if (!agent) {
      return res.status(404).json({
        error: 'Agent configuration not found',
        code: 'AGENT_NOT_FOUND',
      });
    }
    return res.json({ agent: agentService.serializeAgent(agent) });
  } catch (error) {
    return handleAgentError(res, error);
  }
}

async function createAgent(req, res) {
  try {
    const agent = await agentService.createAgent({
      name: req.body && req.body.name,
      languages: req.body && req.body.languages,
    });
    if (req.body && req.body.prompt) {
      await agentService.updateAgent({ prompt: req.body.prompt });
      const refreshed = await agentService.getSingletonAgent();
      return res
        .status(201)
        .json({ agent: agentService.serializeAgent(refreshed) });
    }
    return res.status(201).json({ agent: agentService.serializeAgent(agent) });
  } catch (error) {
    return handleAgentError(res, error);
  }
}

async function updateAgent(req, res) {
  try {
    const agent = await agentService.updateAgent({
      name: req.body && req.body.name,
      status: req.body && req.body.status,
      languages: req.body && req.body.languages,
      prompt: req.body && req.body.prompt,
    });
    return res.json({ agent: agentService.serializeAgent(agent) });
  } catch (error) {
    return handleAgentError(res, error);
  }
}

async function addPrompt(req, res) {
  try {
    const agent = await agentService.addPrompt(req.body && req.body.text);
    return res.status(201).json({ agent: agentService.serializeAgent(agent) });
  } catch (error) {
    return handleAgentError(res, error);
  }
}

async function updatePrompt(req, res) {
  try {
    const agent = await agentService.updatePrompt(
      req.params.promptId,
      req.body && req.body.text
    );
    return res.json({ agent: agentService.serializeAgent(agent) });
  } catch (error) {
    return handleAgentError(res, error);
  }
}

async function deletePrompt(req, res) {
  try {
    const agent = await agentService.deletePrompt(req.params.promptId);
    return res.json({ agent: agentService.serializeAgent(agent) });
  } catch (error) {
    return handleAgentError(res, error);
  }
}

module.exports = {
  getAgent,
  createAgent,
  updateAgent,
  addPrompt,
  updatePrompt,
  deletePrompt,
};
