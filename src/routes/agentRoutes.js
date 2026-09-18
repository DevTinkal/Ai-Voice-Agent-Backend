'use strict';

const express = require('express');
const agentController = require('../controllers/agentController');

const router = express.Router();

router.get('/', agentController.getAgent);
router.post('/', agentController.createAgent);
router.patch('/', agentController.updateAgent);
router.post('/prompts', agentController.addPrompt);
router.patch('/prompts/:promptId', agentController.updatePrompt);
router.delete('/prompts/:promptId', agentController.deletePrompt);

module.exports = router;
