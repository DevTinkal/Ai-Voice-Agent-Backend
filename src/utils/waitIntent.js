'use strict';

/**
 * Generic wait/hold and resume phrase detection (technical mute control).
 * No business / company answers — pattern lists are local heuristics only.
 */

const WAIT_PATTERN_SOURCES = [
  '^\\s*(wait[.!]?\\s*)+$',
  '^\\s*hold\\s+on[.!]?\\s*$',
  '^\\s*hang\\s+on[.!]?\\s*$',
  '^\\s*one\\s+second[.!]?\\s*$',
  '^\\s*one\\s+sec[.!]?\\s*$',
  '^\\s*just\\s+a\\s+(second|sec|moment|minute|min)[.!]?\\s*$',
  '^\\s*give\\s+me\\s+a\\s+(second|sec|moment|minute|min)[.!]?\\s*$',
  '^\\s*please\\s+(wait|hold)[.!]?\\s*$',
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

function compilePatterns(list) {
  return list.map((source) => new RegExp(String(source), 'i'));
}

const WAIT_PATTERNS = compilePatterns(WAIT_PATTERN_SOURCES);
const RESUME_PATTERNS = compilePatterns(RESUME_PATTERN_SOURCES);

function normalize(text) {
  return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ') : '';
}

function isWaitHold(text) {
  const value = normalize(text);
  if (!value) {
    return false;
  }

  if (
    /^(wait|hold|hang)([.\s!,]+(wait|hold|on|hang|please|a|second|sec|moment|minute|min))*$/i.test(
      value
    )
  ) {
    return true;
  }

  const lower = value.toLowerCase();
  const hasWaitIntent =
    /\b(wait|hold on|hang on|please hold|please wait|one second|just a (second|moment|minute)|give me a (second|moment|minute))\b/i.test(
      lower
    );
  if (
    hasWaitIntent &&
    value.split(/\s+/).length <= 10 &&
    !/\b(project|app|website|build|price|cost|need)\b/i.test(lower)
  ) {
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
