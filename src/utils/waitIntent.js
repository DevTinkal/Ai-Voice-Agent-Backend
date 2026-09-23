'use strict';

/**
 * Generic wait/hold and resume phrase detection (technical mute control).
 * Short pause commands only — not business questions that contain "wait".
 * No company-specific terms.
 */

const WAIT_PATTERN_SOURCES = [
  '^\\s*(wait[.!]?\\s*)+$',
  '^\\s*hold\\s+on([.\\s!,]+a\\s+(second|sec|moment|minute|min))?[.!]?\\s*$',
  '^\\s*hang\\s+on([.\\s!,]+a\\s+(second|sec|moment|minute|min))?[.!]?\\s*$',
  '^\\s*one\\s+(second|sec|moment|minute|min)[.!]?\\s*$',
  '^\\s*just\\s+a\\s+(second|sec|moment|minute|min)[.!]?\\s*$',
  '^\\s*give\\s+me\\s+a\\s+(second|sec|moment|minute|min)[.!]?\\s*$',
  '^\\s*please\\s+(wait|hold)([.\\s!,]+(a\\s+)?(second|sec|moment|minute|min))?[.!]?\\s*$',
  '^\\s*please\\s+hold\\s+on[.!]?\\s*$',
  '^\\s*let\\s+me\\s+think[.!]?\\s*$',
  '^\\s*wait\\s+a\\s+(second|sec|moment|minute|min)[.!]?\\s*$',
];

const RESUME_PATTERN_SOURCES = [
  '^\\s*(okay|ok|alright|all\\s+right)[,.]?\\s*(continue|go\\s+on|proceed)?\\.?\\s*$',
  '^\\s*continue\\.?\\s*$',
  '^\\s*go\\s+on\\.?\\s*$',
  '^\\s*proceed\\.?\\s*$',
  '^\\s*i(\'?m|\\s+am)\\s+back\\.?\\s*$',
  '^\\s*ready\\.?\\s*$',
  '^\\s*you\\s+can\\s+continue\\.?\\s*$',
  '^\\s*please\\s+continue\\.?\\s*$',
  '^\\s*(go\\s+ahead|resume)[.!]?\\s*$',
];

/** Tiny STT fragments that must not enter or clear WAIT. */
const HOLD_NOISE_FRAGMENT =
  /^(yo|le|de|uh|um|hmm|ah|oha|aha|mit|e)[.!?]*$/i;

/**
 * Incomplete hold prefixes while Gemini streams partial ASR.
 * Used only to DEFER flush — never to enter WAIT.
 */
const INCOMPLETE_WAIT_PREFIX =
  /^(w|wa|wai|wait\.?|h|ho|hol|hold|hold\s+o|hold\s+on\.?|ha|han|hang|hang\s+o|hang\s+on\.?|o|on|one|one\s+(s|se|sec|seco|secon|second|m|mo|mom|mome|momen|moment|mi|min|minu|minut|minute)?\.?|j|ju|jus|just|just\s+a|g|gi|giv|give|give\s+m|give\s+me|give\s+me\s+a|p|pl|ple|plea|pleas|please|please\s+(w|wa|wai|wait|h|ho|hol|hold)?|l|le|let|let\s+m|let\s+me|let\s+me\s+t|let\s+me\s+th|let\s+me\s+thi|let\s+me\s+thin|let\s+me\s+think\.?)(\s+a(\s+(s|se|sec|seco|secon|second|m|mo|mom|mome|momen|moment|mi|min|minu|minut|minute)?)?)?\.?$/i;

/** Words that indicate a real question / request, not a pure hold. */
const NON_WAIT_CONTENT =
  /\b(what|who|where|when|why|how|which|franchise|requirement|requirements|price|cost|need|project|app|website|build|tell|explain|describe|about|owner|ceo|founder|vehicle|equipment|texas|delivery)\b/i;

function compilePatterns(list) {
  return list.map((source) => new RegExp(String(source), 'i'));
}

const WAIT_PATTERNS = compilePatterns(WAIT_PATTERN_SOURCES);
const RESUME_PATTERNS = compilePatterns(RESUME_PATTERN_SOURCES);

function normalize(text) {
  return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
}

/**
 * True for tiny noise/filler fragments (e.g. "de") that must not
 * enter WAIT or resume from WAIT.
 * @param {string} text
 * @returns {boolean}
 */
function isHoldNoiseFragment(text) {
  const value = normalize(text);
  if (!value) {
    return true;
  }
  return HOLD_NOISE_FRAGMENT.test(value.toLowerCase());
}

/**
 * True when buffer looks like an incomplete hold phrase still being typed by ASR.
 * Never enters WAIT — only delays flush so "wa" is not discarded before "wait".
 * @param {string} text
 * @returns {boolean}
 */
function isIncompleteWaitPrefix(text) {
  const value = normalize(text);
  if (!value) {
    return false;
  }
  if (isWaitHold(value) || isHoldNoiseFragment(value)) {
    return false;
  }
  // Cap length — long buffers are not incomplete prefixes.
  if (value.length > 28 || value.split(/\s+/).length > 5) {
    return false;
  }
  if (NON_WAIT_CONTENT.test(value)) {
    return false;
  }
  return INCOMPLETE_WAIT_PREFIX.test(value);
}

/**
 * True only for short hold/pause commands.
 * @param {string} text
 * @returns {boolean}
 */
function isWaitHold(text) {
  const value = normalize(text);
  if (!value) {
    return false;
  }

  const lower = value.toLowerCase();
  // Explicit non-matches for tiny noise/fragments.
  if (isHoldNoiseFragment(value)) {
    return false;
  }

  const words = value.split(/\s+/).filter(Boolean);
  // Pure hold commands are short. Longer speech with "wait" is usually a question.
  if (words.length > 8) {
    return false;
  }
  if (/\?/.test(value) && words.length > 3) {
    return false;
  }
  if (NON_WAIT_CONTENT.test(lower) && words.length > 4) {
    return false;
  }
  // "Wait, what are ..." — wait + content question
  if (
    /\bwait\b/i.test(lower) &&
    NON_WAIT_CONTENT.test(lower) &&
    words.length >= 3
  ) {
    return false;
  }

  if (WAIT_PATTERNS.some((pattern) => pattern.test(value))) {
    return true;
  }

  // Repeated wait/hold/hang tokens only.
  if (
    /^(wait|hold|hang)([.\s!,]+(wait|hold|on|hang|please|a|second|sec|moment|minute|min))*$/i.test(
      value
    )
  ) {
    return true;
  }

  return false;
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
  isHoldNoiseFragment,
  isIncompleteWaitPrefix,
  normalize,
};
