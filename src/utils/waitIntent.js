'use strict';

/**
 * Detect caller wait/hold and resume phrases from Live input transcription.
 */

const WAIT_PATTERNS = [
  /^\s*(wait[.!]?\s*)+$/i,
  /^\s*hold\s+on[.!]?\s*$/i,
  /^\s*hang\s+on[.!]?\s*$/i,
  /^\s*one\s+second[.!]?\s*$/i,
  /^\s*one\s+sec[.!]?\s*$/i,
  /^\s*just\s+a\s+(second|sec|moment|minute|min)[.!]?\s*$/i,
  /^\s*give\s+me\s+a\s+(second|sec|moment|minute|min)[.!]?\s*$/i,
  /^\s*hold\s+please[.!]?\s*$/i,
  /^\s*please\s+(wait|hold)[.!]?\s*$/i,
  /^\s*wait\s+a\s+(second|sec|moment|minute|min)[.!]?\s*$/i,
  /^\s*can\s+you\s+(wait|hold)\b.*$/i,
  /^\s*wait\s+a\s+(second|sec|moment|minute|min)[,.]?\s*(please\s+)?hold[.!]?\s*$/i,
  /^\s*hang\s+on[,.]?\s*(one|a)?\s*(second|sec|moment|minute)?[.!]?\s*$/i,
  /^\s*hold\s+for\s+a\s+(second|sec|moment|minute)[.!]?\s*$/i,
  /^\s*wait\s+a\s+minute[.!]?\s*$/i,
  /^\s*please\s+wait[,.]?\s*(a\s+)?(second|moment|minute)?[.!]?\s*$/i,
];

const RESUME_PATTERNS = [
  /^\s*(okay|ok|alright|all\s+right)[,.]?\s*(continue|go\s+on|proceed)?\.?\s*$/i,
  /^\s*continue\.?\s*$/i,
  /^\s*go\s+on\.?\s*$/i,
  /^\s*proceed\.?\s*$/i,
  /^\s*i('?m|\s+am)\s+back\.?\s*$/i,
  /^\s*ready\.?\s*$/i,
  /^\s*you\s+can\s+continue\.?\s*$/i,
  /^\s*please\s+continue\.?\s*$/i,
];

function normalize(text) {
  return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
}

function isWaitHold(text) {
  const value = normalize(text);
  if (!value) {
    return false;
  }

  // Short utterances that are only wait-like words.
  if (/^(wait|hold|hang)([.\s!,]+(wait|hold|on|hang|please|a|second|sec|moment|minute|min))*$/i.test(value)) {
    return true;
  }

  // Compound: contains wait/hold intent and is short enough to be a control phrase.
  const lower = value.toLowerCase();
  const hasWaitIntent =
    /\b(wait|hold on|hang on|please hold|please wait|one second|just a (second|moment|minute)|give me a (second|moment|minute))\b/i.test(
      lower
    );
  if (hasWaitIntent && value.split(/\s+/).length <= 10 && !/\b(project|app|website|build|price|cost|need)\b/i.test(lower)) {
    return true;
  }

  return WAIT_PATTERNS.some((pattern) => pattern.test(value));
}

function isResume(text) {
  const value = normalize(text);
  if (!value) {
    return false;
  }
  return RESUME_PATTERNS.some((pattern) => pattern.test(value));
}

module.exports = {
  isWaitHold,
  isResume,
  normalize,
};
