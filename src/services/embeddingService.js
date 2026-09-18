'use strict';

const { env } = require('../config/env');
const { getClient } = require('./geminiLiveService');
const logger = require('../utils/logger');

const DEFAULT_CONCURRENCY = 8;

/**
 * Embedding model id used for both document chunks and query vectors.
 * Must stay identical across indexing and search.
 */
function getEmbeddingModel() {
  return env.geminiEmbeddingModel || 'gemini-embedding-2';
}

function getOutputDimensionality() {
  const n = Number(env.geminiEmbeddingDimensions) || 768;
  return Math.max(1, Math.min(n, 3072));
}

/**
 * Generate one embedding vector for text.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function generateEmbedding(text) {
  const input = String(text || '').trim();
  if (!input) {
    throw new Error('Cannot embed empty text');
  }

  const ai = getClient();
  const model = getEmbeddingModel();
  const response = await ai.models.embedContent({
    model,
    contents: input,
    config: {
      outputDimensionality: getOutputDimensionality(),
    },
  });

  const values =
    response &&
    response.embeddings &&
    response.embeddings[0] &&
    response.embeddings[0].values;

  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('Embedding API returned empty vector');
  }

  return values.map((v) => Number(v));
}

/**
 * Embed many texts with bounded concurrency (indexing path).
 * @param {string[]} texts
 * @param {{ concurrency?: number }} [options]
 * @returns {Promise<number[][]>}
 */
async function generateEmbeddings(texts, options = {}) {
  const list = Array.isArray(texts) ? texts : [];
  const concurrency = Math.max(
    1,
    Math.min(Number(options.concurrency) || DEFAULT_CONCURRENCY, 10)
  );
  const results = new Array(list.length);
  let next = 0;

  async function worker() {
    while (next < list.length) {
      const i = next;
      next += 1;
      results[i] = await generateEmbedding(list[i]);
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, list.length); w += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  logger.info(
    'KNOWLEDGE',
    `embeddings generated count=${list.length} model=${getEmbeddingModel()} dims=${
      results[0] ? results[0].length : 0
    }`
  );
  return results;
}

module.exports = {
  getEmbeddingModel,
  getOutputDimensionality,
  generateEmbedding,
  generateEmbeddings,
};
