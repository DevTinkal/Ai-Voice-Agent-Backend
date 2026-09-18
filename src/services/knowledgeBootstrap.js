'use strict';

/**
 * Startup indexer for the single filesystem knowledge source.
 * Re-indexes only when company.txt (or KNOWLEDGE_SOURCE_PATH) content hash changes.
 * Never runs mid-call.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { env } = require('../config/env');
const { isDatabaseConnected } = require('../config/database');
const { KnowledgeSource } = require('../models/KnowledgeSource');
const { KnowledgeChunk } = require('../models/KnowledgeChunk');
const knowledgeService = require('./knowledgeService');
const embeddingService = require('./embeddingService');
const logger = require('../utils/logger');

const DEFAULT_RELATIVE = path.join('knowledge', 'company.txt');

function resolveKnowledgeSourcePath() {
  const configured = String(env.knowledgeSourcePath || '').trim();
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(__dirname, '../..', configured);
  }
  return path.resolve(__dirname, '../..', DEFAULT_RELATIVE);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function upsertMeta(fields) {
  return KnowledgeSource.findOneAndUpdate(
    { key: 'default' },
    { $set: { key: 'default', ...fields } },
    { upsert: true, new: true }
  ).exec();
}

/**
 * Read knowledge file and index if hash changed.
 * @returns {Promise<object|null>} status summary
 */
async function syncKnowledgeFromFile() {
  if (!isDatabaseConnected()) {
    logger.warn('KNOWLEDGE', 'Skip file sync — database not connected');
    return null;
  }

  const filePath = resolveKnowledgeSourcePath();
  await upsertMeta({ filePath, status: 'pending' });

  if (!fs.existsSync(filePath)) {
    logger.warn(
      'KNOWLEDGE',
      `Knowledge source missing at ${filePath} — place company.txt or set KNOWLEDGE_SOURCE_PATH`
    );
    await upsertMeta({
      filePath,
      status: 'missing',
      error: 'Source file not found',
      chunkCount: 0,
    });
    return knowledgeService.getStatus();
  }

  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (error) {
    logger.error('KNOWLEDGE', `Failed to read knowledge file: ${error.message}`);
    await upsertMeta({
      filePath,
      status: 'failed',
      error: String(error.message).slice(0, 240),
    });
    return knowledgeService.getStatus();
  }

  const text = buffer.toString('utf8').trim();
  if (!text) {
    logger.warn('KNOWLEDGE', `Knowledge source empty at ${filePath}`);
    await upsertMeta({
      filePath,
      status: 'missing',
      error: 'Source file empty',
      charCount: 0,
      chunkCount: 0,
    });
    return knowledgeService.getStatus();
  }

  const contentHash = sha256(buffer);
  const meta = await KnowledgeSource.findOne({ key: 'default' }).exec();

  if (
    meta &&
    meta.contentHash === contentHash &&
    meta.status === 'ready' &&
    meta.documentId
  ) {
    const chunkCount = await KnowledgeChunk.countDocuments({
      documentId: meta.documentId,
    });
    if (chunkCount > 0) {
      logger.info(
        'KNOWLEDGE',
        `KNOWLEDGE_INDEX_SKIP hash unchanged chunks=${chunkCount} chars=${meta.charCount || text.length}`
      );
      await upsertMeta({
        filePath,
        chunkCount,
        status: 'ready',
        error: null,
      });
      return knowledgeService.getStatus();
    }
  }

  await upsertMeta({
    filePath,
    status: 'indexing',
    contentHash,
    charCount: text.length,
    error: null,
  });

  try {
    const doc = await knowledgeService.indexFromFile({
      text,
      contentHash,
      title: 'Company knowledge',
    });
    const chunkCount = await KnowledgeChunk.countDocuments({
      documentId: doc._id,
    });
    await upsertMeta({
      filePath,
      status: 'ready',
      contentHash,
      documentId: doc._id,
      charCount: text.length,
      chunkCount,
      embeddingModel: embeddingService.getEmbeddingModel(),
      error: null,
    });
    logger.info(
      'KNOWLEDGE',
      `KNOWLEDGE_FILE_READY path=${filePath} chunks=${chunkCount} chars=${text.length}`
    );
  } catch (error) {
    const safe = String(error.message || 'Indexing failed').slice(0, 240);
    await upsertMeta({
      filePath,
      status: 'failed',
      contentHash,
      error: safe,
    });
    logger.error('KNOWLEDGE', `KNOWLEDGE_FILE_FAILED: ${safe}`);
  }

  return knowledgeService.getStatus();
}

module.exports = {
  resolveKnowledgeSourcePath,
  syncKnowledgeFromFile,
  sha256,
};
