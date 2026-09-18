'use strict';

const express = require('express');
const knowledgeController = require('../controllers/knowledgeController');

const router = express.Router();

router.get('/status', knowledgeController.getStatus);
router.get('/', knowledgeController.getStatus);

router.post('/', knowledgeController.methodNotAllowed);
router.patch('/:id', knowledgeController.methodNotAllowed);
router.delete('/:id', knowledgeController.methodNotAllowed);
router.get('/:id', knowledgeController.methodNotAllowed);

module.exports = router;
