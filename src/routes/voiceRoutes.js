'use strict';

const express = require('express');
const voiceController = require('../controllers/voiceController');

const router = express.Router();

router.post('/', voiceController.handleIncomingCall);
router.post('/outbound', voiceController.handleOutboundTwiml);
router.post('/outbound-status', voiceController.handleOutboundStatus);
router.get('/outbound-greeting/:callSid', voiceController.handleOutboundGreetingClip);

module.exports = router;
