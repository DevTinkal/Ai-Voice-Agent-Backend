'use strict';

const { env } = require('../config/env');
const { getClient } = require('./geminiLiveService');
const logger = require('../utils/logger');

const DEFAULT_CONCURRENCY = 6;
/**
 * gemini embedContent returns one vector even when contents is an array,
 * so multi-text batches only add retries. Keep one text per request.
 */
const DEFAULT_BATCH_SIZE = 1;
/** Per-request wall clock; hung API calls must not leave UI on Indexing forever. */
const EMBED_TIMEOUT_MS = 45000;
const MAX_RETRIES = 2;

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

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function extractVectors(response, expectedCount) {
  const list =
    response && Array.isArray(response.embeddings) ? response.embeddings : [];
  if (list.length !== expectedCount) {
    throw new Error(
      `Embedding API returned ${list.length} vectors, expected ${expectedCount}`
    );
  }
  return list.map((entry, i) => {
    const values = entry && Array.isArray(entry.values) ? entry.values : null;
    if (!values || values.length === 0) {
      throw new Error(`Embedding API returned empty vector at index ${i}`);
    }
    return values.map((v) => Number(v));
  });
}

/**
 * Embed one or more texts in a single API call.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
async function embedBatch(texts) {
  const inputs = texts.map((t) => String(t || '').trim());
  if (inputs.some((t) => !t)) {
    throw new Error('Cannot embed empty text');
  }

  const ai = getClient();
  const model = getEmbeddingModel();
  const contents = inputs.length === 1 ? inputs[0] : inputs;

  let lastError;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await withTimeout(
        ai.models.embedContent({
          model,
          contents,
          config: {
            outputDimensionality: getOutputDimensionality(),
          },
        }),
        EMBED_TIMEOUT_MS,
        `embedContent(n=${inputs.length})`
      );
      return extractVectors(response, inputs.length);
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const delayMs = 500 * (attempt + 1);
        logger.warn(
          'KNOWLEDGE',
          `embed retry ${attempt + 1}/${MAX_RETRIES} after ${String(error.message || error).slice(0, 120)}`
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw lastError;
}

/**
 * Generate one embedding vector for text.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
async function generateEmbedding(text) {
  const [vector] = await embedBatch([text]);
  return vector;
}

/**
 * Embed many texts with batched requests + bounded concurrency.
 * @param {string[]} texts
 * @param {{ concurrency?: number, batchSize?: number }} [options]
 * @returns {Promise<number[][]>}
 */
async function generateEmbeddings(texts, options = {}) {
  const list = Array.isArray(texts) ? texts : [];
  if (!list.length) {
    return [];
  }

  const concurrency = Math.max(
    1,
    Math.min(Number(options.concurrency) || DEFAULT_CONCURRENCY, 8)
  );
  const batchSize = Math.max(
    1,
    Math.min(Number(options.batchSize) || DEFAULT_BATCH_SIZE, 32)
  );

  /** @type {{ start: number, items: string[] }[]} */
  const batches = [];
  for (let i = 0; i < list.length; i += batchSize) {
    batches.push({
      start: i,
      items: list.slice(i, i + batchSize),
    });
  }

  const results = new Array(list.length);
  let nextBatch = 0;
  let completed = 0;
  const startedAt = Date.now();

  logger.info(
    'KNOWLEDGE',
    `embeddings start count=${list.length} batches=${batches.length} batchSize=${batchSize} concurrency=${concurrency} model=${getEmbeddingModel()}`
  );

  async function worker() {
    while (nextBatch < batches.length) {
      const batchIndex = nextBatch;
      nextBatch += 1;
      const batch = batches[batchIndex];
      let vectors;
      try {
        vectors = await embedBatch(batch.items);
      } catch (batchError) {
        if (batch.items.length === 1) {
          throw batchError;
        }
        // Fallback: embed one-by-one so a batch-API quirk does not fail the whole index.
        logger.warn(
          'KNOWLEDGE',
          `batch embed failed at ${batch.start}: ${String(batchError.message || batchError).slice(0, 140)} — falling back to singles`
        );
        vectors = [];
        for (const item of batch.items) {
          const [one] = await embedBatch([item]);
          vectors.push(one);
        }
      }
      for (let j = 0; j < vectors.length; j += 1) {
        results[batch.start + j] = vectors[j];
      }
      completed += batch.items.length;
      if (
        completed === list.length ||
        completed % Math.max(batchSize * 2, 50) < batch.items.length
      ) {
        const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
        logger.info(
          'KNOWLEDGE',
          `embeddings progress ${completed}/${list.length} elapsed=${elapsedSec}s`
        );
      }
    }
  }

  const workers = [];
  for (let w = 0; w < Math.min(concurrency, batches.length); w += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  logger.info(
    'KNOWLEDGE',
    `embeddings generated count=${list.length} model=${getEmbeddingModel()} dims=${
      results[0] ? results[0].length : 0
    } elapsedMs=${Date.now() - startedAt}`
  );
  return results;
}

module.exports = {
  getEmbeddingModel,
  getOutputDimensionality,
  generateEmbedding,
  generateEmbeddings,
  EMBED_TIMEOUT_MS,
};
