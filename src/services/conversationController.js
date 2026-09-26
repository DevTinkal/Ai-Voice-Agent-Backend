'use strict';

/**
 * Lexical turn classification for the classic STT→LLM→TTS pipeline.
 * Advises the orchestrator; does not replace barge-in audio or WAIT state.
 */

const {
  isWaitHold,
  isHoldNoiseFragment,
  isIncompleteWaitPrefix,
  normalize: normalizeWaitText,
} = require('../utils/waitIntent');

const TURN = Object.freeze({
  WAIT: 'WAIT',
  BACKCHANNEL: 'BACKCHANNEL',
  NEW_REQUEST: 'NEW_REQUEST',
  INCOMPLETE: 'INCOMPLETE',
  COMPLETE: 'COMPLETE',
  NOISE: 'NOISE',
  ACK_ONLY: 'ACK_ONLY',
});

const BACKCHANNEL_ALONE =
  /^(yeah|yep|yup|yes|ok|okay|right|sure|uh-huh|uhhuh|mm-hmm|mmhmm|mhm|got\s+it|gotcha|alright|all\s+right|mm|hmm|aha|ah)[.!?]*$/i;

const ACK_THEN_CONTENT =
  /^(yeah|yep|yup|yes|ok|okay|right|sure|uh-huh|got\s+it|gotcha|alright)[,.]?\s+(but|and|so|what|who|where|when|why|how|about|the|can|could|would|is|are|do|does|did|i|we|my)\b/i;

const INCOMPLETE_TRAILING =
  /^(i('?m|\s+am)\s+(looking|trying|wanting|thinking|calling)|i\s+want\s+to|i\s+need\s+to|we('?re|\s+are)\s+(looking|trying)|looking\s+for(\s+a|\s+an)?|and\s+also|so\s+i|because\s+i)\b/i;

const INCOMPLETE_SHORT_OPENERS =
  /^(this\s+is|that\s+is|there\s+is|it\s+is|i\s+need|i\s+want|i\s+have|we\s+need|we\s+want|who\s+is(\s+the)?|what\s+is(\s+the)?|where\s+is|how\s+(do|can|much|many)|looking\s+for(\s+a|\s+an)?)\.?$/i;

const INCOMPLETE_ENDS_OPEN =
  /\b(is|are|am|was|were|the|a|an|to|for|of|and|or|but|with|my|our|your)\s*$/i;

/** Repeated "who is the" stutter with no noun — keep listening. */
const WHO_IS_THE_STUTTER =
  /^(and\s+)?who\s+is\s+the(\s+and\s+who\s+is\s+the)+\s*$/i;

const PURE_GREETING =
  /^(hi|hello|hey|thanks|thank\s+you)[.?!]*$/i;

function normalize(text) {
  return normalizeWaitText(text) || String(text || '').trim().replace(/\s+/g, ' ');
}

function isNoiseLike(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  const alnum = raw.replace(/[^a-zA-Z0-9]/g, '');
  if (alnum.length < 2) return true;
  if (/^[\s.!?…,;:\-_"'`~]+$/.test(raw)) return true;
  if (isHoldNoiseFragment(raw)) return true;
  return false;
}

function looksIncompleteUtterance(value, words, hasQuestion) {
  if (WHO_IS_THE_STUTTER.test(value)) {
    return true;
  }
  // "who is the" / "and who is the" with no noun yet
  if (!hasQuestion && /^(and\s+)?who\s+is\s+the\s*$/i.test(value)) {
    return true;
  }
  if (hasQuestion || /[.!?]$/.test(value)) {
    return false;
  }
  if (words.length > 8) {
    return false;
  }
  if (INCOMPLETE_TRAILING.test(value) || INCOMPLETE_SHORT_OPENERS.test(value)) {
    return true;
  }
  if (words.length <= 5 && INCOMPLETE_ENDS_OPEN.test(value)) {
    return true;
  }
  return false;
}

/**
 * High-precision Play-greeting echo only — never drop real "This is Tinkle" intros.
 * @param {string} value
 * @param {string[]} words
 * @param {string} [agentName]
 */
function isGreetingEchoScrap(value, words, agentName) {
  if (words.length > 6) return false;
  if (/\bhow\s+can\s+i\s+help\b/i.test(value)) return true;
  if (/\bthank\s+you\b/i.test(value)) return true;
  const name = String(agentName || '')
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (name && words.length <= 3) {
    const re = new RegExp(`^i'?m\\s+${name}[.!?]*$`, 'i');
    if (re.test(value)) return true;
  }
  return false;
}

/**
 * @param {string} text
 * @param {{ aiSpeaking?: boolean, waiting?: boolean, alreadyGreeted?: boolean, agentName?: string }} [ctx]
 */
function classifyCallerTurn(text, ctx = {}) {
  const value = normalize(text);
  const aiSpeaking = Boolean(ctx.aiSpeaking);
  const waiting = Boolean(ctx.waiting);
  const alreadyGreeted = Boolean(ctx.alreadyGreeted);

  if (isNoiseLike(value)) {
    return { class: TURN.NOISE, reason: 'noise_or_empty', text: value };
  }
  if (isWaitHold(value)) {
    return { class: TURN.WAIT, reason: 'wait_hold_phrase', text: value };
  }
  if (isIncompleteWaitPrefix(value)) {
    return { class: TURN.INCOMPLETE, reason: 'incomplete_wait_prefix', text: value };
  }

  const words = value.split(/\s+/).filter(Boolean);

  // Pure hi/hello after we already opened — short ack only, never re-greet.
  if (alreadyGreeted && PURE_GREETING.test(value)) {
    return { class: TURN.ACK_ONLY, reason: 'pure_greeting_after_open', text: value };
  }

  // After our opening Play clip, Flux often hears scraps of our own greeting.
  if (alreadyGreeted && isGreetingEchoScrap(value, words, ctx.agentName)) {
    return { class: TURN.NOISE, reason: 'greeting_echo_scrap', text: value };
  }

  if (ACK_THEN_CONTENT.test(value)) {
    return { class: TURN.NEW_REQUEST, reason: 'ack_then_content', text: value };
  }
  if (aiSpeaking && !waiting && BACKCHANNEL_ALONE.test(value)) {
    return { class: TURN.BACKCHANNEL, reason: 'alone_ack_while_ai_speaking', text: value };
  }
  if (waiting && BACKCHANNEL_ALONE.test(value)) {
    return { class: TURN.BACKCHANNEL, reason: 'alone_ack_while_waiting', text: value };
  }

  const hasQuestion = /\?/.test(value);

  // Early Flux scraps / tiny questions without enough content — keep listening.
  // Hello? is handled above as ACK_ONLY when already greeted.
  const SHORT_SCRAP_Q =
    /^(are\s+you|you|who\s+are|what\s+is|what\s+'?s|which|how|why|where|when)\??$/i;
  if (
    (words.length <= 2 && hasQuestion && SHORT_SCRAP_Q.test(value)) ||
    (words.length <= 2 &&
      hasQuestion &&
      !PURE_GREETING.test(value) &&
      !/^(hi|hello|hey)\?$/i.test(value))
  ) {
    return { class: TURN.INCOMPLETE, reason: 'short_question_scrap', text: value };
  }

  if (looksIncompleteUtterance(value, words, hasQuestion)) {
    return { class: TURN.INCOMPLETE, reason: 'incomplete_mid_thought', text: value };
  }
  // Clear finished questions need enough substance (not "are you?").
  if (hasQuestion && words.length >= 3) {
    return { class: TURN.COMPLETE, reason: 'clear_utterance', text: value };
  }
  if (!hasQuestion && (words.length >= 3 || PURE_GREETING.test(value))) {
    return { class: TURN.COMPLETE, reason: 'clear_utterance', text: value };
  }
  if (words.length <= 2 && BACKCHANNEL_ALONE.test(value)) {
    return { class: TURN.COMPLETE, reason: 'short_ack_idle', text: value };
  }
  return { class: TURN.COMPLETE, reason: 'default_complete', text: value };
}

function shouldEmitCallerMessage(turnClass) {
  return (
    turnClass === TURN.WAIT ||
    turnClass === TURN.NEW_REQUEST ||
    turnClass === TURN.COMPLETE ||
    turnClass === TURN.ACK_ONLY
  );
}

function shouldAnswer(turnClass) {
  return turnClass === TURN.NEW_REQUEST || turnClass === TURN.COMPLETE;
}

function shouldResumeWait(turnClass) {
  return shouldAnswer(turnClass);
}

module.exports = {
  TURN,
  classifyCallerTurn,
  shouldEmitCallerMessage,
  shouldAnswer,
  shouldResumeWait,
  normalize,
  isGreetingEchoScrap,
  PURE_GREETING,
};
