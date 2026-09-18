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
const logger = require('../utils/logger');

const CHUNK_TARGET_CHARS = 1000;
const CHUNK_OVERLAP_CHARS = 150;

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
async function indexDocument(documentId) {
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

  try {
    const texts = chunkText(doc.rawText);
    if (!texts.length) {
      throw new Error('No chunks produced from document text');
    }

    const embeddings = await embeddingService.generateEmbeddings(texts);
    if (embeddings.length !== texts.length) {
      throw new Error('Embedding count mismatch');
    }
    for (let i = 0; i < embeddings.length; i += 1) {
      if (!Array.isArray(embeddings[i]) || embeddings[i].length === 0) {
        throw new Error(`Empty embedding at chunk ${i}`);
      }
    }

    const modelName = embeddingService.getEmbeddingModel();
    const newRows = texts.map((text, index) => ({
      documentId: doc._id,
      index,
      text,
      embedding: embeddings[index],
      charCount: text.length,
    }));

    const oldIds = (
      await KnowledgeChunk.find({ documentId: doc._id }).select('_id').lean().exec()
    ).map((c) => c._id);

    await KnowledgeChunk.insertMany(newRows);

    if (oldIds.length) {
      await KnowledgeChunk.deleteMany({ _id: { $in: oldIds } });
    }

    doc.status = 'ready';
    doc.charCount = String(doc.rawText || '').length;
    doc.embeddingModel = modelName;
    doc.error = null;
    await doc.save();

    logger.info(
      'KNOWLEDGE',
      `KNOWLEDGE_INDEX_READY document=${doc._id} chunks=${newRows.length} chars=${doc.charCount}`
    );
    return doc;
  } catch (error) {
    const safe = String(error.message || 'Indexing failed')
      .replace(/key[=:\s][^\s]+/gi, '[redacted]')
      .slice(0, 240);
    doc.status = 'failed';
    doc.error = safe;
    await doc.save().catch(() => {});
    logger.error('KNOWLEDGE', `KNOWLEDGE_INDEX_FAILED document=${doc._id}: ${safe}`);
    throw error;
  }
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
  return true;
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
 * source:'agent' document; safe swap of chunks; on failure keeps prior ready index.
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

  const previousRaw = doc.rawText;
  const previousStatus = doc.status;

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
      `KNOWLEDGE_INDEX_START document=${doc._id} source=agent chars=${trimmed.length}`
    );
    return await indexDocument(doc._id);
  } catch (error) {
    // Preserve previous ready corpus when re-index fails.
    doc.rawText = previousRaw;
    doc.charCount = String(previousRaw || '').length;
    doc.status =
      previousStatus === 'ready' || previousStatus === 'indexing'
        ? previousStatus === 'ready'
          ? 'ready'
          : 'failed'
        : previousStatus || 'failed';
    if (previousStatus === 'ready') {
      doc.status = 'ready';
      doc.error = `Re-index failed; previous index kept. ${String(error.message || '').slice(0, 160)}`;
    } else {
      doc.status = 'failed';
      doc.error = String(error.message || 'Indexing failed').slice(0, 240);
    }
    await doc.save().catch(() => {});
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
  };
}

/**
 * @param {string} query
 * @param {{ topK?: number, maxChars?: number, minScore?: number }} [options]
 */
async function searchKnowledge(query, options = {}) {
  const q = String(query || '').trim();
  const topK = Math.max(
    1,
    Number(options.topK) || env.knowledgeTopK || 5
  );
  const maxChars = Math.max(
    200,
    Number(options.maxChars) || env.knowledgeMaxChars || 6000
  );
  const minScore = Number(
    options.minScore != null ? options.minScore : env.knowledgeMinScore || 0
  );

  const empty = (message) => ({
    snippets: [],
    usedFallback: false,
    message,
  });

  if (!q) {
    return empty('No relevant knowledge was found.');
  }

  try {
    if (!isDatabaseConnected()) {
      return empty('Knowledge search is temporarily unavailable.');
    }

    const readyDocs = await KnowledgeDocument.find({ status: 'ready' })
      .select('_id title')
      .lean()
      .exec();
    if (!readyDocs.length) {
      return empty('No relevant knowledge was found.');
    }

    const titleById = new Map(
      readyDocs.map((d) => [String(d._id), d.title || 'Untitled'])
    );
    const readyIds = readyDocs.map((d) => d._id);

    const queryEmbedding = await embeddingService.generateEmbedding(q);

    const chunks = await KnowledgeChunk.find({ documentId: { $in: readyIds } })
      .select('text embedding documentId')
      .lean()
      .exec();

    if (!chunks.length) {
      return empty('No relevant knowledge was found.');
    }

    /** @type {{ text: string, score: number, title: string }[]} */
    const scored = [];
    let dimMismatch = 0;
    for (const chunk of chunks) {
      const score = cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score == null) {
        dimMismatch += 1;
        continue;
      }
      if (score < minScore) continue;
      scored.push({
        text: chunk.text,
        score,
        title: titleById.get(String(chunk.documentId)) || 'Untitled',
      });
    }
    if (dimMismatch > 0) {
      logger.warn(
        'KNOWLEDGE',
        `cosine skipped mismatched/empty vectors count=${dimMismatch}`
      );
    }

    scored.sort((a, b) => b.score - a.score);

    /** @type {{ text: string, score: number, title: string }[]} */
    const selected = [];
    const seenNorm = new Set();
    let totalChars = 0;

    for (const item of scored) {
      if (selected.length >= topK) break;
      const norm = item.text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 200);
      if (seenNorm.has(norm)) continue;
      if (totalChars + item.text.length > maxChars && selected.length > 0) {
        continue;
      }
      if (item.text.length > maxChars && selected.length === 0) {
        selected.push({
          ...item,
          text: item.text.slice(0, maxChars),
        });
        totalChars += maxChars;
        break;
      }
      seenNorm.add(norm);
      selected.push(item);
      totalChars += item.text.length;
    }

    const preview = q.slice(0, 100);
    const topScore = selected[0] ? selected[0].score : 0;
    logger.info(
      'KNOWLEDGE',
      `KNOWLEDGE_SEARCH query="${preview}" hits=${selected.length} topScore=${topScore.toFixed(3)}`
    );

    if (!selected.length) {
      return empty('No relevant knowledge was found.');
    }

    return {
      snippets: selected.map((s) => ({
        title: s.title,
        score: Math.round(s.score * 1000) / 1000,
        text: s.text,
      })),
      usedFallback: false,
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
  deleteDocument,
  listDocuments,
  getDocument,
  getStatus,
  searchKnowledge,
};
