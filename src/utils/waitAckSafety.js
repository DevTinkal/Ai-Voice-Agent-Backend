'use strict';

/**
 * Heuristic gate for one-shot WAIT hold acknowledgements.
 * Not a phrase allowlist — rejects answer/RAG/follow-up leaks while allowing
 * short conversational hold lines with natural variation.
 */

const MAX_HOLD_ACK_WORDS = 12;
const MAX_HOLD_ACK_CHARS = 100;

/** Generic answer-leak markers (not company-specific). */
const ANSWER_LEAK_RE =
  /\b(pricing|price|cost|ceo|founder|owner|president|franchise|investment|requirements?|features?|budget|timeline|located|location|according|explain|regarding|knowledge|documents?|snippets?|application|prototype|qualify|qualification|company|product|service|fee|fees)\b/i;

/**
 * @param {string} text
 * @returns {{ ok: boolean, reason: string }}
 */
function evaluateWaitHoldAck(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return { ok: false, reason: 'empty' };
  }
  if (raw.length > MAX_HOLD_ACK_CHARS) {
    return { ok: false, reason: 'too_long_chars' };
  }
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length > MAX_HOLD_ACK_WORDS) {
    return { ok: false, reason: 'too_long_words' };
  }
  // Hold acks should not ask business / qualification questions.
  if (raw.includes('?')) {
    return { ok: false, reason: 'question' };
  }
  const sentences = raw
    .split(/[.!?]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (sentences.length > 2) {
    return { ok: false, reason: 'too_many_sentences' };
  }
  if (ANSWER_LEAK_RE.test(raw)) {
    return { ok: false, reason: 'answer_leak' };
  }
  // Multi-clause "Sure, no rush. The …" already caught by leak / length;
  // reject obvious continuations after a hold opener.
  if (/\b(so,?\s+regarding|let me explain|the way it works|based on)\b/i.test(raw)) {
    return { ok: false, reason: 'continuation' };
  }
  return { ok: true, reason: 'short_hold_ack' };
}

function isShortHoldAckText(text) {
  return evaluateWaitHoldAck(text).ok;
}

module.exports = {
  MAX_HOLD_ACK_WORDS,
  MAX_HOLD_ACK_CHARS,
  evaluateWaitHoldAck,
  isShortHoldAckText,
};
