'use strict';

/**
 * In-memory knowledge index for fast live searchKnowledge.
 * Lexical (local) first → embedding cosine fallback. LRU caches results.
 * Snapshot is swapped atomically after Mongo reload so in-flight searches never see empty mid-rebuild.
 */

const { KnowledgeDocument } = require('../models/KnowledgeDocument');
const { KnowledgeChunk } = require('../models/KnowledgeChunk');
const { isDatabaseConnected } = require('../config/database');
const embeddingService = require('./embeddingService');
const logger = require('../utils/logger');

const LRU_MAX = 128;
/** Minimum lexical score (shared-token fraction) to skip embedding API. */
const LEXICAL_THRESHOLD = 0.35;
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'to',
  'of',
  'in',
  'on',
  'for',
  'with',
  'and',
  'or',
  'but',
  'if',
  'at',
  'by',
  'from',
  'as',
  'it',
  'this',
  'that',
  'these',
  'those',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'what',
  'which',
  'who',
  'how',
  'do',
  'does',
  'did',
  'can',
  'could',
  'would',
  'should',
  'will',
  'my',
  'your',
  'our',
  'their',
  'me',
  'about',
  'into',
  'than',
  'then',
  'so',
  'just',
  'not',
  'no',
  'yes',
  'please',
  'tell',
  'know',
  'want',
  'need',
]);

/** @type {{ chunks: object[], inverted: Map<string, number[]> } | null} */
let snapshot = null;

/** @type {Map<string, { snippets: object[], path: string }>} */
const lruCache = new Map();

function tokenize(text) {
  const raw = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s%-]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  for (const t of raw) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

function normalizeQueryKey(query) {
  return String(query || '')
    .toLowerCase()
    .replace(/[^\w\s%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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

function lruGet(key) {
  if (!lruCache.has(key)) return null;
  const val = lruCache.get(key);
  lruCache.delete(key);
  lruCache.set(key, val);
  return val;
}

function lruSet(key, value) {
  if (lruCache.has(key)) {
    lruCache.delete(key);
  }
  lruCache.set(key, value);
  while (lruCache.size > LRU_MAX) {
    const oldest = lruCache.keys().next().value;
    lruCache.delete(oldest);
  }
}

function clearCache() {
  lruCache.clear();
}

/**
 * Drop the in-memory corpus immediately (e.g. after Agent Prompt Save)
 * so live search cannot return stale chunks while re-indexing.
 */
function invalidate() {
  snapshot = { chunks: [], inverted: new Map() };
  clearCache();
  logger.info('KNOWLEDGE', 'RAM index invalidated (awaiting rebuild)');
}

function getChunkCount() {
  return snapshot && Array.isArray(snapshot.chunks) ? snapshot.chunks.length : 0;
}

function isWarm() {
  return getChunkCount() > 0;
}

/**
 * Load ready chunks from Mongo into a new snapshot, then swap atomically.
 */
async function reloadFromMongo() {
  if (!isDatabaseConnected()) {
    snapshot = { chunks: [], inverted: new Map() };
    clearCache();
    logger.warn('KNOWLEDGE', 'RAM index reload skipped — DB not connected');
    return { chunkCount: 0 };
  }

  const readyDocs = await KnowledgeDocument.find({ status: 'ready' })
    .select('_id title')
    .lean()
    .exec();

  if (!readyDocs.length) {
    snapshot = { chunks: [], inverted: new Map() };
    clearCache();
    logger.info('KNOWLEDGE', 'RAM index empty — no ready documents');
    return { chunkCount: 0 };
  }

  const titleById = new Map(
    readyDocs.map((d) => [String(d._id), d.title || 'Untitled'])
  );
  const readyIds = readyDocs.map((d) => d._id);

  const rows = await KnowledgeChunk.find({ documentId: { $in: readyIds } })
    .select('text embedding documentId')
    .lean()
    .exec();

  const chunks = [];
  const inverted = new Map();

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const text = String(row.text || '');
    const tokens = tokenize(text);
    const tokenSet = new Set(tokens);
    chunks.push({
      text,
      embedding: Array.isArray(row.embedding) ? row.embedding : [],
      title: titleById.get(String(row.documentId)) || 'Untitled',
      documentId: String(row.documentId),
      tokens,
      tokenSet,
    });
    for (const t of tokenSet) {
      let list = inverted.get(t);
      if (!list) {
        list = [];
        inverted.set(t, list);
      }
      list.push(i);
    }
  }

  snapshot = { chunks, inverted };
  clearCache();
  logger.info('KNOWLEDGE', `RAM index ready chunks=${chunks.length}`);
  return { chunkCount: chunks.length };
}

/**
 * Install a test/manual snapshot (bypasses Mongo). Clears LRU.
 * @param {{ text: string, embedding?: number[], title?: string }[]} chunkRows
 */
function loadSnapshotForTests(chunkRows) {
  const rows = Array.isArray(chunkRows) ? chunkRows : [];
  const chunks = [];
  const inverted = new Map();
  for (let i = 0; i < rows.length; i += 1) {
    const text = String(rows[i].text || '');
    const tokens = tokenize(text);
    const tokenSet = new Set(tokens);
    chunks.push({
      text,
      embedding: Array.isArray(rows[i].embedding) ? rows[i].embedding : [],
      title: rows[i].title || 'Untitled',
      documentId: String(rows[i].documentId || 'test'),
      tokens,
      tokenSet,
    });
    for (const t of tokenSet) {
      let list = inverted.get(t);
      if (!list) {
        list = [];
        inverted.set(t, list);
      }
      list.push(i);
    }
  }
  snapshot = { chunks, inverted };
  clearCache();
}

function selectSnippets(scored, topK, maxChars) {
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

  return selected.map((s) => ({
    title: s.title,
    score: Math.round(s.score * 1000) / 1000,
    text: s.text,
  }));
}

function lexicalRank(queryTokens) {
  const snap = snapshot;
  if (!snap || !snap.chunks.length || !queryTokens.length) {
    return [];
  }

  const candidateIdx = new Set();
  for (const t of queryTokens) {
    const list = snap.inverted.get(t);
    if (list) {
      for (const i of list) candidateIdx.add(i);
    }
  }

  const qSet = new Set(queryTokens);
  const qLen = qSet.size || 1;
  const phrase = queryTokens.join(' ');

  const scored = [];
  for (const i of candidateIdx) {
    const chunk = snap.chunks[i];
    let hit = 0;
    for (const t of qSet) {
      if (chunk.tokenSet.has(t)) hit += 1;
    }
    let score = hit / qLen;
    if (phrase.length >= 4 && chunk.text.toLowerCase().includes(phrase)) {
      score = Math.min(1, score + 0.15);
    }
    if (score <= 0) continue;
    scored.push({
      text: chunk.text,
      score,
      title: chunk.title,
    });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * @param {string} query
 * @param {{ topK?: number, maxChars?: number, minScore?: number, callSid?: string }} [options]
 * @returns {Promise<{ snippets: object[], path: string, message?: string, durationMs: number, candidates: number }>}
 */
async function searchLocal(query, options = {}) {
  const started = Date.now();
  const q = String(query || '').trim();
  const topK = Math.max(1, Number(options.topK) || 3);
  const maxChars = Math.max(200, Number(options.maxChars) || 3000);
  const minScore = Number(options.minScore != null ? options.minScore : 0);
  const callId = options.callSid ? String(options.callSid) : '-';

  function finish(path, snippets, candidates, message) {
    const durationMs = Date.now() - started;
    const hits = Array.isArray(snippets) ? snippets.length : 0;
    logger.info(
      'KNOWLEDGE',
      `KNOWLEDGE_SEARCH call=${callId} path=${path} duration_ms=${durationMs} candidates=${candidates} hits=${hits}`
    );
    const out = {
      snippets: snippets || [],
      path,
      durationMs,
      candidates,
    };
    if (message) out.message = message;
    return out;
  }

  if (!q) {
    return finish('empty', [], 0, 'No relevant knowledge was found.');
  }

  const cacheKey = `${normalizeQueryKey(q)}|${topK}|${maxChars}`;
  const cached = lruGet(cacheKey);
  if (cached && cached.snippets && cached.snippets.length) {
    return finish(
      'cache',
      cached.snippets,
      cached.candidates != null ? cached.candidates : cached.snippets.length
    );
  }

  if (!isWarm()) {
    return finish('cold', [], 0, 'No relevant knowledge was found.');
  }

  const queryTokens = tokenize(q);
  const lexicalScored = lexicalRank(queryTokens);
  const bestLex = lexicalScored[0] ? lexicalScored[0].score : 0;
  const lexicalCandidates = lexicalScored.length;

  if (bestLex >= LEXICAL_THRESHOLD) {
    const snippets = selectSnippets(lexicalScored, topK, maxChars);
    if (snippets.length) {
      lruSet(cacheKey, {
        snippets,
        path: 'lexical',
        candidates: lexicalCandidates,
      });
      return finish('lexical', snippets, lexicalCandidates);
    }
  }

  const queryEmbedding = await embeddingService.generateEmbedding(q);
  const snap = snapshot;
  const scored = [];
  let dimMismatch = 0;
  for (const chunk of snap.chunks) {
    const score = cosineSimilarity(queryEmbedding, chunk.embedding);
    if (score == null) {
      dimMismatch += 1;
      continue;
    }
    if (score < minScore) continue;
    scored.push({
      text: chunk.text,
      score,
      title: chunk.title,
    });
  }
  if (dimMismatch > 0) {
    logger.warn(
      'KNOWLEDGE',
      `cosine skipped mismatched/empty vectors count=${dimMismatch}`
    );
  }
  scored.sort((a, b) => b.score - a.score);
  const semanticCandidates = scored.length;
  const snippets = selectSnippets(scored, topK, maxChars);

  if (!snippets.length) {
    return finish(
      'semantic',
      [],
      semanticCandidates,
      'No relevant knowledge was found.'
    );
  }

  lruSet(cacheKey, {
    snippets,
    path: 'semantic',
    candidates: semanticCandidates,
  });
  return finish('semantic', snippets, semanticCandidates);
}

module.exports = {
  LRU_MAX,
  LEXICAL_THRESHOLD,
  tokenize,
  normalizeQueryKey,
  cosineSimilarity,
  reloadFromMongo,
  loadSnapshotForTests,
  searchLocal,
  clearCache,
  invalidate,
  isWarm,
  getChunkCount,
};
