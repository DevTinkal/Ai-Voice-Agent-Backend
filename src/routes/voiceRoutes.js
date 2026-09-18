'use strict';

const express = require('express');
const voiceController = require('../controllers/voiceController');

const router = express.Router();

router.post('/', voiceController.handleIncomingCall);
router.post('/outbound', voiceController.handleOutboundTwiml);

module.exports = router;
