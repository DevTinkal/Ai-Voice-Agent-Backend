'use strict';

const { GoogleGenAI } = require('@google/genai');
const { env } = require('../config/env');
const {
  SYSTEM_INSTRUCTION,
  FALLBACK_SPEECH,
  buildSystemInstruction,
} = require('../config/prompts');
const { DEFAULT_TIMEZONE } = require('../utils/timeOfDay');
const logger = require('../utils/logger');

let client = null;

/** Real phone models — prefer 3.8 Flash, keep lite/flash as backup. */
const FALLBACK_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
];

const PHONE_MAX_OUTPUT_TOKENS = 450;
const REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_QUOTA_COOLDOWN_MS = 60_000;

/** @type {Map<string, number>} model -> cooldownUntil epoch ms */
const modelCooldowns = new Map();

function getClient() {
  if (!env.geminiApiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  if (!client) {
    client = new GoogleGenAI({ apiKey: env.geminiApiKey });
  }

  return client;
}

/**
 * Convert message history into Gemini contents format.
 * @param {Array<{role: string, content: string}>} messages
 */
function buildContents(messages) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));
}

function markCooldown(model, ms) {
  const until = Date.now() + Math.max(ms, 5_000);
  modelCooldowns.set(model, until);
  logger.warn(
    'GEMINI',
    `Cooling down ${model} for ${Math.ceil(ms / 1000)}s (quota/unavailable)`
  );
}

function isOnCooldown(model) {
  const until = modelCooldowns.get(model);
  if (!until) {
    return false;
  }
  if (Date.now() >= until) {
    modelCooldowns.delete(model);
    return false;
  }
  return true;
}

function modelCandidates() {
  const preferred = env.geminiModel || 'gemini-3.8-flash';
  const ordered = [
    preferred,
    ...FALLBACK_MODELS.filter((m) => m !== preferred),
  ];

  const available = ordered.filter((m) => !isOnCooldown(m));
  if (available.length > 0) {
    return available;
  }

  // All cooled down — try preferred anyway rather than silent failure.
  return [preferred];
}

function hasPriorAssistantTurn(history) {
  if (!Array.isArray(history)) {
    return false;
  }
  return history.some((m) => {
    if (!m || typeof m !== 'object') {
      return false;
    }
    return m.role === 'assistant' || m.role === 'model';
  });
}

function isThinkingConfigError(error) {
  const raw = String(error && error.message ? error.message : error || '');
  return /thinking/i.test(raw) || /thinkingConfig/i.test(raw);
}

/**
 * Spoken answer text only — skip thought/reasoning parts.
 * @param {object} responseOrChunk
 * @returns {string}
 */
function extractAnswerText(responseOrChunk) {
  if (!responseOrChunk) {
    return '';
  }

  const candidates = responseOrChunk.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const parts =
      candidates[0] &&
      candidates[0].content &&
      Array.isArray(candidates[0].content.parts)
        ? candidates[0].content.parts
        : [];

    if (parts.length > 0) {
      let droppedThoughts = false;
      const answer = parts
        .filter((part) => {
          if (!part || typeof part.text !== 'string' || !part.text) {
            return false;
          }
          if (part.thought === true) {
            droppedThoughts = true;
            return false;
          }
          return true;
        })
        .map((part) => part.text)
        .join('');

      if (droppedThoughts) {
        logger.info('GEMINI', 'Dropped thought parts from model output');
      }
      return answer;
    }
  }

  // Fallback: SDK text getter already excludes thoughts when available.
  if (typeof responseOrChunk.text === 'string') {
    return responseOrChunk.text;
  }
  return '';
}

/**
 * @param {AbortSignal|undefined} abortSignal
 * @param {Array<{role: string, content: string}>|undefined} history
 * @param {{ includeThinking?: boolean }} [options]
 */
function buildConfig(abortSignal, history, options = {}) {
  const midCall = hasPriorAssistantTurn(history);
  const includeThinking = options.includeThinking !== false;
  const config = {
    // Rebuild each request so morning/afternoon/evening and call phase stay accurate.
    systemInstruction: buildSystemInstruction(
      FALLBACK_SPEECH,
      new Date(),
      DEFAULT_TIMEZONE,
      { midCall }
    ),
    maxOutputTokens: PHONE_MAX_OUTPUT_TOKENS,
  };

  if (includeThinking) {
    // Gemini 3.x Flash: SDK enum values are LOW|MEDIUM|HIGH (docs also accept lowercase).
    // Use uppercase enum strings so thinkingLevel is not silently ignored → default medium.
    config.thinkingConfig = {
      thinkingLevel: 'LOW',
      includeThoughts: false,
    };
  }

  if (abortSignal) {
    config.abortSignal = abortSignal;
  }

  return config;
}

function isAbortError(error) {
  if (!error) {
    return false;
  }
  if (error.name === 'AbortError') {
    return true;
  }
  const message = String(error.message || '').toLowerCase();
  return message.includes('abort') || message.includes('cancel');
}

function summarizeError(error) {
  const raw = String(error && error.message ? error.message : error || '');
  if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
    return '429 quota exceeded';
  }
  if (raw.includes('503') || raw.includes('UNAVAILABLE')) {
    return '503 unavailable';
  }
  if (raw.includes('404') || raw.includes('not found')) {
    return '404 not found';
  }
  return raw.slice(0, 180);
}

function parseRetryDelayMs(error) {
  const raw = String(error && error.message ? error.message : '');
  const match =
    raw.match(/retry in ([\d.]+)s/i) ||
    raw.match(/"retryDelay":\s*"(\d+)s"/i);
  if (match) {
    return Math.ceil(Number(match[1]) * 1000);
  }
  return DEFAULT_QUOTA_COOLDOWN_MS;
}

function shouldCooldown(error) {
  const raw = String(error && error.message ? error.message : '');
  return (
    raw.includes('429') ||
    raw.includes('RESOURCE_EXHAUSTED') ||
    raw.includes('503') ||
    raw.includes('UNAVAILABLE') ||
    raw.includes('high demand')
  );
}

/**
 * Race a Gemini call against a hard timeout so phone callers are never left silent.
 */
function withTimeout(promise, ms, abortController) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        abortController.abort();
      } catch {
        // ignore
      }
      reject(new Error(`timeout after ${ms}ms`));
    }, ms);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function mergeAbortSignals(externalSignal) {
  const local = new AbortController();
  if (externalSignal) {
    if (externalSignal.aborted) {
      local.abort();
    } else {
      externalSignal.addEventListener(
        'abort',
        () => {
          try {
            local.abort();
          } catch {
            // ignore
          }
        },
        { once: true }
      );
    }
  }
  return local;
}

/**
 * Generate a complete assistant reply (non-streaming fallback).
 * @param {Array<{role: string, content: string}>} history
 * @param {{ abortSignal?: AbortSignal, maxModels?: number }} [options]
 * @returns {Promise<{ text: string, streamed: boolean, aborted?: boolean }>}
 */
async function generateResponse(history, options = {}) {
  logger.info('GEMINI', 'Generating response');

  try {
    const ai = getClient();
    const contents = buildContents(history);

    if (contents.length === 0) {
      return { text: FALLBACK_SPEECH, streamed: false };
    }

    let lastError = null;
    const maxModels =
      typeof options.maxModels === 'number' && options.maxModels > 0
        ? options.maxModels
        : modelCandidates().length;
    const candidates = modelCandidates().slice(0, maxModels);

    for (const model of candidates) {
      if (options.abortSignal && options.abortSignal.aborted) {
        return { text: '', streamed: false, aborted: true };
      }

      const result = await generateContentOnce(
        ai,
        model,
        contents,
        history,
        options.abortSignal
      );
      if (result.aborted) {
        return { text: '', streamed: false, aborted: true };
      }
      if (result.text) {
        logger.info('GEMINI', `Response generated with ${model}`);
        return { text: result.text, streamed: false };
      }
      lastError = result.error || lastError;
    }

    logger.error(
      'GEMINI',
      `Generation failed: ${lastError ? summarizeError(lastError) : 'unknown'}`
    );
    return { text: FALLBACK_SPEECH, streamed: false };
  } catch (error) {
    if (isAbortError(error)) {
      return { text: '', streamed: false, aborted: true };
    }
    logger.error('GEMINI', `Generation failed: ${summarizeError(error)}`);
    return { text: FALLBACK_SPEECH, streamed: false };
  }
}

/**
 * One model attempt; retries once without thinkingConfig if needed.
 */
async function generateContentOnce(ai, model, contents, history, abortSignal) {
  for (const includeThinking of [true, false]) {
    if (abortSignal && abortSignal.aborted) {
      return { aborted: true };
    }

    const localAbort = mergeAbortSignals(abortSignal);
    try {
      const response = await withTimeout(
        ai.models.generateContent({
          model,
          contents,
          config: buildConfig(localAbort.signal, history, { includeThinking }),
        }),
        REQUEST_TIMEOUT_MS,
        localAbort
      );

      const text = extractAnswerText(response).trim();

      if (!text) {
        logger.warn('GEMINI', `Empty response from model ${model}`);
        return { error: new Error(`Empty response from ${model}`) };
      }

      return { text };
    } catch (error) {
      if (isAbortError(error) || (abortSignal && abortSignal.aborted)) {
        if (
          String(error.message || '').includes('timeout') ||
          !abortSignal ||
          !abortSignal.aborted
        ) {
          logger.warn(
            'GEMINI',
            `Model ${model} failed: ${summarizeError(error)}`
          );
          if (
            shouldCooldown(error) ||
            String(error.message || '').includes('timeout')
          ) {
            markCooldown(
              model,
              shouldCooldown(error) ? parseRetryDelayMs(error) : 15_000
            );
          }
          return { error };
        }
        return { aborted: true };
      }

      logger.warn('GEMINI', `Model ${model} failed: ${summarizeError(error)}`);
      if (includeThinking && isThinkingConfigError(error)) {
        logger.info('GEMINI', `Retrying ${model} without thinkingConfig`);
        continue;
      }
      if (shouldCooldown(error)) {
        markCooldown(model, parseRetryDelayMs(error));
      }
      return { error };
    }
  }

  return { error: new Error(`Model ${model} failed`) };
}

/**
 * Open a stream for one model; retries once without thinkingConfig if needed.
 */
async function openModelStream(ai, model, contents, history, abortSignal) {
  let lastError = null;

  for (const includeThinking of [true, false]) {
    if (abortSignal && abortSignal.aborted) {
      return { aborted: true };
    }

    const localAbort = mergeAbortSignals(abortSignal);
    try {
      const stream = await withTimeout(
        ai.models.generateContentStream({
          model,
          contents,
          config: buildConfig(localAbort.signal, history, { includeThinking }),
        }),
        REQUEST_TIMEOUT_MS,
        localAbort
      );
      return { stream };
    } catch (error) {
      lastError = error;
      if (isAbortError(error) || (abortSignal && abortSignal.aborted)) {
        if (abortSignal && abortSignal.aborted) {
          return { aborted: true };
        }
        logger.warn(
          'GEMINI',
          `Stream model ${model} failed: ${summarizeError(error)}`
        );
        markCooldown(model, 15_000);
        return { error };
      }

      logger.warn(
        'GEMINI',
        `Stream model ${model} failed: ${summarizeError(error)}`
      );

      if (includeThinking && isThinkingConfigError(error)) {
        logger.info('GEMINI', `Retrying stream ${model} without thinkingConfig`);
        continue;
      }

      if (shouldCooldown(error)) {
        markCooldown(model, parseRetryDelayMs(error));
      }
      return { error };
    }
  }

  return { error: lastError || new Error(`Stream ${model} failed`) };
}

/**
 * Stream assistant tokens for ConversationRelay TTS.
 * Yields { token, last }. Does not invent Twilio fields.
 *
 * @param {Array<{role: string, content: string}>} history
 * @param {{ abortSignal?: AbortSignal }} [options]
 */
async function* generateResponseStream(history, options = {}) {
  const abortSignal = options.abortSignal;
  const requestStartedAt = Date.now();

  try {
    const ai = getClient();
    const contents = buildContents(history);

    const historyMessages = contents.length;
    const historyChars = contents.reduce((sum, c) => {
      const text =
        c.parts && c.parts[0] && typeof c.parts[0].text === 'string'
          ? c.parts[0].text
          : '';
      return sum + text.length;
    }, 0);
    logger.info(
      'AI',
      `history_messages=${historyMessages} history_chars=${historyChars}`
    );

    if (contents.length === 0) {
      yield { token: FALLBACK_SPEECH, last: true };
      return;
    }

    let lastError = null;
    const candidates = modelCandidates();

    for (const model of candidates) {
      if (abortSignal && abortSignal.aborted) {
        return;
      }

      logger.info(
        'GEMINI',
        `Streaming response with ${model} thinkingLevel=LOW includeThoughts=false`
      );
      const openStartedAt = Date.now();
      const opened = await openModelStream(
        ai,
        model,
        contents,
        history,
        abortSignal
      );

      if (opened.aborted) {
        logger.info('GEMINI', 'Stream aborted');
        return;
      }
      if (!opened.stream) {
        lastError = opened.error || lastError;
        continue;
      }

      logger.info(
        'AI',
        `stream_opened_ms=${Date.now() - openStartedAt} since_request_ms=${Date.now() - requestStartedAt}`
      );

      let yieldedAny = false;
      let loggedFirstChunk = false;
      let loggedFirstNonempty = false;
      try {
        for await (const chunk of opened.stream) {
          if (abortSignal && abortSignal.aborted) {
            logger.info('GEMINI', 'Stream aborted');
            return;
          }

          if (!loggedFirstChunk) {
            loggedFirstChunk = true;
            logger.info(
              'AI',
              `first_chunk_received: ${Date.now() - requestStartedAt}ms`
            );
          }

          const token = extractAnswerText(chunk);
          if (!token) {
            continue;
          }

          if (!loggedFirstNonempty) {
            loggedFirstNonempty = true;
            logger.info(
              'AI',
              `first_nonempty_text_received: ${Date.now() - requestStartedAt}ms model=${model}`
            );
          }

          // Immediate yield — no lookahead hold (faster first spoken word).
          yield { token, last: false };
          yieldedAny = true;
        }

        logger.info(
          'AI',
          `stream_completed: ${Date.now() - requestStartedAt}ms yielded=${yieldedAny}`
        );

        if (yieldedAny) {
          yield { token: '', last: true };
          return;
        }

        lastError = new Error(`Empty stream from ${model}`);
        logger.warn('GEMINI', lastError.message);
      } catch (error) {
        if (isAbortError(error) || (abortSignal && abortSignal.aborted)) {
          if (abortSignal && abortSignal.aborted) {
            logger.info('GEMINI', 'Stream aborted');
            return;
          }
          lastError = error;
          logger.warn(
            'GEMINI',
            `Stream model ${model} failed: ${summarizeError(error)}`
          );
          markCooldown(model, 15_000);
          if (!yieldedAny) {
            continue;
          }
          return;
        }

        lastError = error;
        logger.warn(
          'GEMINI',
          `Stream model ${model} failed: ${summarizeError(error)}`
        );
        if (shouldCooldown(error)) {
          markCooldown(model, parseRetryDelayMs(error));
        }
        if (!yieldedAny) {
          continue;
        }
        return;
      }
    }

    // At most one non-stream attempt — avoid multi-model death marches.
    logger.warn(
      'GEMINI',
      `Stream failed across models (${lastError ? summarizeError(lastError) : 'empty'}); one non-stream fallback`
    );

    const fallback = await generateResponse(history, {
      abortSignal,
      maxModels: 1,
    });
    if (fallback.aborted) {
      return;
    }
    yield { token: fallback.text || FALLBACK_SPEECH, last: true };
  } catch (error) {
    if (isAbortError(error) || (abortSignal && abortSignal.aborted)) {
      return;
    }
    logger.error('GEMINI', `Stream generation failed: ${summarizeError(error)}`);
    yield { token: FALLBACK_SPEECH, last: true };
  }
}

module.exports = {
  generateResponse,
  generateResponseStream,
  SYSTEM_INSTRUCTION,
  FALLBACK_SPEECH,
};
