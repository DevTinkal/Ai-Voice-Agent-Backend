'use strict';

const express = require('express');
const callController = require('../controllers/callController');

const router = express.Router();

router.get('/', callController.listCalls);
router.get('/:callSid', callController.getCall);

module.exports = router;
