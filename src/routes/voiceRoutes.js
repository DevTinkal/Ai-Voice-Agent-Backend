'use strict';

const express = require('express');
const voiceController = require('../controllers/voiceController');

const router = express.Router();

router.post('/', voiceController.handleIncomingCall);

module.exports = router;
