'use strict';

/**
 * Knowledge RAG: documents are externalized from Gemini Live systemInstruction.
 * Chunks are embedded (gemini-embedding-2) and retrieved on demand via searchKnowledge.
 * This is NOT unlimited Gemini context — only top snippets are sent per tool call.
 */

const { KnowledgeDocument } = require('../models/KnowledgeDocument');
const { KnowledgeChunk } = require('../models/KnowledgeChunk');
const { isDatabaseConnected } = require('../config/database');
const { env } = require('../config/env');
const embeddingService = require('./embeddingService');
const knowledgeMemoryIndex = require('./knowledgeMemoryIndex');
const logger = require('../utils/logger');

const CHUNK_TARGET_CHARS = 1000;
const CHUNK_OVERLAP_CHARS = 150;
/** Hard ceiling so a hung embedding run cannot leave the UI on Indexing forever. */
const INDEX_TIMEOUT_MS = 12 * 60 * 1000;
/** Only one index rebuild at a time — overlapping Saves/restarts must not double-embed. */
let indexInFlight = null;

/**
 * Live indexing progress for dashboard (in-memory; cleared when idle).
 * @type {{
 *   active: boolean,
 *   phase: string,
 *   completed: number,
 *   total: number,
 *   percent: number,
 * } | null}
 */
let indexProgress = null;

function setIndexProgress(partial) {
  if (!partial) {
    indexProgress = null;
    return;
  }
  const completed = Math.max(0, Number(partial.completed) || 0);
  const total = Math.max(0, Number(partial.total) || 0);
  let percent = Number(partial.percent);
  if (!Number.isFinite(percent)) {
    if (total > 0) {
      // Embeddings map to 10–95%; leave headroom for chunk/save phases.
      percent = 10 + Math.round((completed / total) * 85);
    } else {
      percent = 5;
    }
  }
  percent = Math.max(0, Math.min(99, Math.round(percent)));
  indexProgress = {
    active: true,
    phase: String(partial.phase || 'indexing'),
    completed,
    total,
    percent,
  };
}

function clearIndexProgress() {
  indexProgress = null;
}

function getIndexProgress() {
  return indexProgress
    ? { ...indexProgress }
    : { active: false, phase: 'idle', completed: 0, total: 0, percent: 0 };
}

class KnowledgeError extends Error {
  constructor(message, status = 400, code = 'KNOWLEDGE_ERROR') {
    super(message);
    this.name = 'KnowledgeError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Safe cosine similarity. Returns null if vectors are unusable.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number|null}
 */
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
    return null;
  }
  if (a.length !== b.length) {
    return null;
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) {
    return null;
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Paragraph-aware chunking with ~1000 char targets and ~150 char overlap.
 * @param {string} rawText
 * @returns {string[]}
 */
function chunkText(rawText) {
  const normalized = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim();
  if (!normalized) {
    return [];
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  /** @type {string[]} */
  const units = [];
  for (const para of paragraphs) {
    if (para.length <= CHUNK_TARGET_CHARS) {
      units.push(para);
      continue;
    }
    // Hard-split oversized paragraphs without losing text.
    let start = 0;
    while (start < para.length) {
      let end = Math.min(start + CHUNK_TARGET_CHARS, para.length);
      if (end < para.length) {
        const slice = para.slice(start, end);
        const breakAt = Math.max(
          slice.lastIndexOf('\n'),
          slice.lastIndexOf('. '),
          slice.lastIndexOf(' ')
        );
        if (breakAt > CHUNK_TARGET_CHARS * 0.4) {
          end = start + breakAt + 1;
        }
      }
      const piece = para.slice(start, end).trim();
      if (piece) units.push(piece);
      if (end >= para.length) break;
      start = Math.max(end - CHUNK_OVERLAP_CHARS, start + 1);
    }
  }

  /** @type {string[]} */
  const chunks = [];
  let buffer = '';

  function flushBuffer() {
    const t = buffer.trim();
    if (t) chunks.push(t);
    buffer = '';
  }

  for (const unit of units) {
    if (!buffer) {
      buffer = unit;
      continue;
    }
    const combined = `${buffer}\n\n${unit}`;
    if (combined.length <= CHUNK_TARGET_CHARS) {
      buffer = combined;
      continue;
    }
    flushBuffer();
    // Overlap: carry tail of previous chunk into the next buffer when possible.
    const prev = chunks[chunks.length - 1] || '';
    if (prev.length > CHUNK_OVERLAP_CHARS) {
      const overlap = prev.slice(-CHUNK_OVERLAP_CHARS);
      buffer = `${overlap}\n\n${unit}`.trim();
      if (buffer.length > CHUNK_TARGET_CHARS * 1.5) {
        buffer = unit;
      }
    } else {
      buffer = unit;
    }
  }
  flushBuffer();

  return chunks.length ? chunks : [normalized];
}

function serializeDocumentMeta(doc) {
  const d = typeof doc.toObject === 'function' ? doc.toObject() : doc;
  return {
    id: String(d._id),
    title: d.title,
    source: d.source,
    status: d.status,
    charCount: d.charCount || 0,
    error: d.error || null,
    embeddingModel: d.embeddingModel || null,
    createdAt: d.createdAt || null,
    updatedAt: d.updatedAt || null,
  };
}

function serializeDocumentDetail(doc) {
  return {
    ...serializeDocumentMeta(doc),
    rawText: doc.rawText,
  };
}

/**
 * @param {{ title: string, text: string, source?: string }} input
 */
async function createDocument({ title, text, source }) {
  if (!isDatabaseConnected()) {
    throw new KnowledgeError(
      'Unable to store knowledge — database not connected',
      500,
      'KNOWLEDGE_DB_UNAVAILABLE'
    );
  }
  const trimmedTitle = String(title || '').trim();
  const trimmedText = String(text || '').trim();
  if (!trimmedTitle) {
    throw new KnowledgeError('Title is required', 400, 'KNOWLEDGE_TITLE_REQUIRED');
  }
  if (!trimmedText) {
    throw new KnowledgeError(
      'Knowledge text is required',
      400,
      'KNOWLEDGE_TEXT_REQUIRED'
    );
  }

  const doc = await KnowledgeDocument.create({
    title: trimmedTitle,
    source: source === 'upload' ? 'upload' : 'paste',
    rawText: trimmedText,
    charCount: trimmedText.length,
    status: 'pending',
    error: null,
  });

  logger.info(
    'KNOWLEDGE',
    `KNOWLEDGE_INDEX_START document=${doc._id} chars=${trimmedText.length}`
  );

  // Background indexing — do not block the HTTP response.
  setImmediate(() => {
    indexDocument(doc._id).catch((error) => {
      logger.error(
        'KNOWLEDGE',
        `index failed document=${doc._id}: ${error.message}`
      );
    });
  });

  return doc;
}

/**
 * Safe reindex: build new chunks+embeddings, insert, then delete old chunks.
 * @param {string|import('mongoose').Types.ObjectId} documentId
 */
async function indexDocumentOnce(documentId) {
  if (!isDatabaseConnected()) {
    throw new KnowledgeError(
      'Unable to index knowledge — database not connected',
      500,
      'KNOWLEDGE_DB_UNAVAILABLE'
    );
  }

  const doc = await KnowledgeDocument.findById(documentId).exec();
  if (!doc) {
    throw new KnowledgeError('Knowledge document not found', 404, 'KNOWLEDGE_NOT_FOUND');
  }

  doc.status = 'indexing';
  doc.error = null;
  await doc.save();
  setIndexProgress({ phase: 'chunking', completed: 0, total: 0, percent: 5 });

  try {
    const runIndex = async () => {
      const texts = chunkText(doc.rawText);
      if (!texts.length) {
        throw new Error('No chunks produced from document text');
      }

      logger.info(
        'KNOWLEDGE',
        `KNOWLEDGE_INDEX_CHUNKS document=${doc._id} chunks=${texts.length} chars=${String(doc.rawText || '').length}`
      );

      setIndexProgress({
        phase: 'embedding',
        completed: 0,
        total: texts.length,
        percent: 10,
      });

      // Drop previous chunks for this document first so old prompt text cannot
      // be retrieved while (or if) the new embedding run fails.
      await KnowledgeChunk.deleteMany({ documentId: doc._id });
      // Ensure RAM cannot serve stale vectors during rebuild.
      knowledgeMemoryIndex.invalidate();

      const embeddings = await embeddingService.generateEmbeddings(texts, {
        onProgress: ({ completed, total }) => {
          setIndexProgress({
            phase: 'embedding',
            completed,
            total,
          });
        },
      });
      if (embeddings.length !== texts.length) {
        throw new Error('Embedding count mismatch');
      }
      for (let i = 0; i < embeddings.length; i += 1) {
        if (!Array.isArray(embeddings[i]) || embeddings[i].length === 0) {
          throw new Error(`Empty embedding at chunk ${i}`);
        }
      }

      setIndexProgress({
        phase: 'saving',
        completed: texts.length,
        total: texts.length,
        percent: 96,
      });

      const modelName = embeddingService.getEmbeddingModel();
      const newRows = texts.map((text, index) => ({
        documentId: doc._id,
        index,
        text,
        embedding: embeddings[index],
        charCount: text.length,
      }));

      await KnowledgeChunk.insertMany(newRows);

      doc.status = 'ready';
      doc.charCount = String(doc.rawText || '').length;
      doc.embeddingModel = modelName;
      doc.error = null;
      await doc.save();

      logger.info(
        'KNOWLEDGE',
        `KNOWLEDGE_INDEX_READY document=${doc._id} chunks=${newRows.length} chars=${doc.charCount}`
      );

      try {
        await knowledgeMemoryIndex.reloadFromMongo();
      } catch (reloadErr) {
        logger.warn(
          'KNOWLEDGE',
          `RAM index reload after index failed: ${String(reloadErr.message || reloadErr).slice(0, 160)}`
        );
      }

      setIndexProgress({
        phase: 'ready',
        completed: texts.length,
        total: texts.length,
        percent: 100,
      });
      return doc;
    };

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Indexing timed out after ${Math.round(INDEX_TIMEOUT_MS / 1000)}s — try a smaller prompt or Save again`
          )
        );
      }, INDEX_TIMEOUT_MS);
    });
    try {
      return await Promise.race([runIndex(), timeout]);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const safe = String(error.message || 'Indexing failed')
      .replace(/key[=:\s][^\s]+/gi, '[redacted]')
      .slice(0, 240);
    doc.status = 'failed';
    doc.error = safe;
    await doc.save().catch(() => {});
    knowledgeMemoryIndex.invalidate();
    clearIndexProgress();
    logger.error('KNOWLEDGE', `KNOWLEDGE_INDEX_FAILED document=${doc._id}: ${safe}`);
    throw error;
  } finally {
    if (doc.status === 'ready') {
      // Keep 100% briefly visible via getStatus until next idle poll clears.
      setTimeout(() => clearIndexProgress(), 2000);
    }
  }
}

async function indexDocument(documentId) {
  if (indexInFlight) {
    logger.info(
      'KNOWLEDGE',
      `Index already in flight — waiting instead of starting another (${documentId})`
    );
    return indexInFlight;
  }
  indexInFlight = indexDocumentOnce(documentId).finally(() => {
    indexInFlight = null;
  });
  return indexInFlight;
}

/**
 * After a process restart, docs left in pending/indexing never finish.
 * Re-queue agent (and any other) interrupted documents from saved rawText.
 * Does not restore old chunks — rebuilds from current rawText only.
 */
async function resumeInterruptedIndexing() {
  if (!isDatabaseConnected()) {
    return { resumed: 0 };
  }

  const stuck = await KnowledgeDocument.find({
    status: { $in: ['pending', 'indexing'] },
  })
    .select('_id source status charCount')
    .lean()
    .exec();

  if (!stuck.length) {
    return { resumed: 0 };
  }

  logger.warn(
    'KNOWLEDGE',
    `Resuming ${stuck.length} interrupted index job(s): ${stuck
      .map((d) => `${d._id}:${d.status}`)
      .join(', ')}`
  );

  for (const row of stuck) {
    setImmediate(() => {
      indexDocument(row._id).catch((error) => {
        logger.error(
          'KNOWLEDGE',
          `Resume index failed document=${row._id}: ${error.message}`
        );
      });
    });
  }

  return { resumed: stuck.length };
}

async function deleteDocument(documentId) {
  if (!isDatabaseConnected()) {
    throw new KnowledgeError(
      'Unable to delete knowledge — database not connected',
      500,
      'KNOWLEDGE_DB_UNAVAILABLE'
    );
  }
  const doc = await KnowledgeDocument.findById(documentId).exec();
  if (!doc) {
    throw new KnowledgeError('Knowledge document not found', 404, 'KNOWLEDGE_NOT_FOUND');
  }
  await KnowledgeChunk.deleteMany({ documentId: doc._id });
  await KnowledgeDocument.deleteOne({ _id: doc._id });
  logger.info('KNOWLEDGE', `deleted document=${doc._id}`);
  try {
    await knowledgeMemoryIndex.reloadFromMongo();
  } catch (reloadErr) {
    logger.warn(
      'KNOWLEDGE',
      `RAM index reload after delete failed: ${String(reloadErr.message || reloadErr).slice(0, 160)}`
    );
  }
  return true;
}

/**
 * Drop all knowledge docs/chunks + RAM index (used when Agent prompt is cleared).
 * Does not touch Call / Agent collections.
 */
async function clearAllKnowledge() {
  if (!isDatabaseConnected()) {
    knowledgeMemoryIndex.invalidate();
    return { cleared: false };
  }
  knowledgeMemoryIndex.invalidate();
  await KnowledgeChunk.deleteMany({});
  await KnowledgeDocument.deleteMany({});
  knowledgeMemoryIndex.invalidate();
  logger.info('KNOWLEDGE', 'KNOWLEDGE_CLEARED all documents and chunks removed');
  return { cleared: true };
}

async function listDocuments() {
  if (!isDatabaseConnected()) {
    throw new KnowledgeError(
      'Unable to list knowledge — database not connected',
      500,
      'KNOWLEDGE_DB_UNAVAILABLE'
    );
  }
  const docs = await KnowledgeDocument.find()
    .select('title source status charCount error embeddingModel createdAt updatedAt')
    .sort({ createdAt: -1 })
    .lean()
    .exec();
  return docs.map((d) => serializeDocumentMeta(d));
}

async function getDocument(documentId) {
  if (!isDatabaseConnected()) {
    throw new KnowledgeError(
      'Unable to load knowledge — database not connected',
      500,
      'KNOWLEDGE_DB_UNAVAILABLE'
    );
  }
  const doc = await KnowledgeDocument.findById(documentId).exec();
  if (!doc) {
    throw new KnowledgeError('Knowledge document not found', 404, 'KNOWLEDGE_NOT_FOUND');
  }
  return serializeDocumentDetail(doc);
}

/**
 * Index (or re-index) the singleton Agent.prompt as the searchable corpus.
 * source:'agent' document; replaces rawText and chunks with NEW prompt only.
 * Old agent-specific chunks are removed before new ones are inserted.
 * @param {string} text - Full Agent.prompt
 */
async function indexFromAgentPrompt(text) {
  if (!isDatabaseConnected()) {
    throw new KnowledgeError(
      'Unable to index knowledge — database not connected',
      500,
      'KNOWLEDGE_DB_UNAVAILABLE'
    );
  }
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    throw new KnowledgeError(
      'Agent prompt is empty',
      400,
      'KNOWLEDGE_TEXT_REQUIRED'
    );
  }

  // Immediately drop stale RAM/LRU so live calls cannot hit old company text.
  knowledgeMemoryIndex.invalidate();

  // Prefer agent-sourced index; migrate away from file/paste as runtime truth.
  let doc = await KnowledgeDocument.findOne({ source: 'agent' }).exec();
  if (!doc) {
    doc = await KnowledgeDocument.create({
      title: 'Agent prompt index',
      source: 'agent',
      rawText: trimmed,
      charCount: trimmed.length,
      status: 'pending',
      error: null,
    });
  }

  // Full replace of corpus text — never append/merge with previous rawText.
  doc.rawText = trimmed;
  doc.charCount = trimmed.length;
  doc.title = 'Agent prompt index';
  doc.source = 'agent';
  doc.status = 'indexing';
  doc.error = null;
  await doc.save();

  // Drop non-agent docs so search uses one corpus.
  const extras = await KnowledgeDocument.find({
    _id: { $ne: doc._id },
  })
    .select('_id')
    .lean()
    .exec();
  for (const extra of extras) {
    await KnowledgeChunk.deleteMany({ documentId: extra._id });
    await KnowledgeDocument.deleteOne({ _id: extra._id });
  }

  try {
    logger.info(
      'KNOWLEDGE',
      `KNOWLEDGE_INDEX_START document=${doc._id} source=agent chars=${trimmed.length} replace=true`
    );
    return await indexDocument(doc._id);
  } catch (error) {
    // Keep NEW rawText (replacement already saved). Do not restore old corpus.
    doc.status = 'failed';
    doc.error = String(error.message || 'Indexing failed').slice(0, 240);
    await doc.save().catch(() => {});
    knowledgeMemoryIndex.invalidate();
    throw error;
  }
}

/**
 * Lightweight status for Admin badge (agent-prompt index).
 */
async function getStatus() {
  if (!isDatabaseConnected()) {
    return {
      status: 'unavailable',
      charCount: 0,
      chunkCount: 0,
      contentHash: null,
      filePath: null,
      error: 'Database not connected',
      embeddingModel: null,
      progress: getIndexProgress(),
    };
  }

  const agentDoc = await KnowledgeDocument.findOne({ source: 'agent' })
    .select('status charCount embeddingModel error')
    .lean()
    .exec();

  // Fallback: any ready doc (legacy) until agent re-save.
  const doc =
    agentDoc ||
    (await KnowledgeDocument.findOne({ status: 'ready' })
      .select('status charCount embeddingModel error source')
      .lean()
      .exec());

  let chunkCount = 0;
  if (doc && doc._id) {
    chunkCount = await KnowledgeChunk.countDocuments({ documentId: doc._id });
  }

  return {
    status: (doc && doc.status) || 'missing',
    charCount: (doc && doc.charCount) || 0,
    chunkCount,
    contentHash: null,
    filePath: null,
    error: (doc && doc.error) || null,
    embeddingModel: (doc && doc.embeddingModel) || null,
    progress: getIndexProgress(),
  };
}

/**
 * Fast path: RAM index (cache → lexical → semantic). Cold index triggers one reload.
 * @param {string} query
 * @param {{ topK?: number, maxChars?: number, minScore?: number, callSid?: string }} [options]
 */
async function searchKnowledge(query, options = {}) {
  const q = String(query || '')
    .replace(/\s+/g, ' ')
    .trim();
  const topK = Math.max(
    1,
    Number(options.topK) || env.knowledgeTopK || 3
  );
  const maxChars = Math.max(
    200,
    Number(options.maxChars) || env.knowledgeMaxChars || 3000
  );
  const minScore = Number(
    options.minScore != null ? options.minScore : env.knowledgeMinScore || 0
  );
  const callSid = options.callSid;

  const empty = (message, meta = {}) => ({
    snippets: [],
    usedFallback: false,
    found: false,
    message,
    path: meta.path || null,
    durationMs: meta.durationMs != null ? meta.durationMs : null,
    candidates: meta.candidates != null ? meta.candidates : 0,
  });

  if (!q) {
    return empty('No relevant knowledge was found.');
  }

  try {
    if (!knowledgeMemoryIndex.isWarm()) {
      if (isDatabaseConnected()) {
        await knowledgeMemoryIndex.reloadFromMongo();
      }
    }

    if (!knowledgeMemoryIndex.isWarm()) {
      return empty('No relevant knowledge was found.', { path: 'cold' });
    }

    const result = await knowledgeMemoryIndex.searchLocal(q, {
      topK,
      maxChars,
      minScore,
      callSid,
    });

    if (!result.snippets || !result.snippets.length) {
      return empty(result.message || 'No relevant knowledge was found.', {
        path: result.path,
        durationMs: result.durationMs,
        candidates: result.candidates,
      });
    }

    return {
      snippets: result.snippets,
      usedFallback: false,
      found: true,
      path: result.path,
      durationMs: result.durationMs,
      candidates: result.candidates,
    };
  } catch (error) {
    logger.error(
      'KNOWLEDGE',
      `search failed: ${String(error.message || error).slice(0, 200)}`
    );
    return empty('Knowledge search is temporarily unavailable.');
  }
}

module.exports = {
  KnowledgeError,
  CHUNK_TARGET_CHARS,
  CHUNK_OVERLAP_CHARS,
  cosineSimilarity,
  chunkText,
  serializeDocumentMeta,
  createDocument,
  indexDocument,
  indexFromAgentPrompt,
  resumeInterruptedIndexing,
  INDEX_TIMEOUT_MS,
  deleteDocument,
  clearAllKnowledge,
  listDocuments,
  getDocument,
  getStatus,
  getIndexProgress,
  searchKnowledge,
};
