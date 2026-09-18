'use strict';

/**
 * Detect and strip model planning / CoT / meta text that must never be spoken.
 */

const META_PATTERNS = [
  /caller said\s*:/i,
  /likely meant/i,
  /need concise/i,
  /natural phone style/i,
  /no greetings/i,
  /direct answer\/question/i,
  /current state\s*:/i,
  /the user is asking/i,
  /violating the/i,
  /mid-call\.?\s*do not greet/i,
  /chain-of-thought/i,
  /internal reasoning/i,
  /\*\s*caller said/i,
];

/**
 * @param {string} text
 * @returns {boolean}
 */
function isMetaLeak(text) {
  const t = String(text || '').trim();
  if (!t) {
    return false;
  }
  if (META_PATTERNS.some((re) => re.test(t))) {
    return true;
  }
  // Planning wrapped in markdown emphasis.
  if (/^\s*\*.*\b(caller said|need concise|likely meant)\b/i.test(t)) {
    return true;
  }
  return false;
}

/**
 * If text mixes planning with a trailing spoken sentence, keep the spoken tail.
 * @param {string} text
 * @returns {string|null} clean spoken text, or null if none recoverable
 */
function toSpokenOnly(text) {
  let t = String(text || '').trim();
  if (!t) {
    return null;
  }
  if (!isMetaLeak(t)) {
    return t;
  }

  // Drop wrapping asterisks only (do not delete the whole body).
  t = t.replace(/^\*+\s*/, '').replace(/\s*\*+$/, '').trim();

  // Drop sentences that are clearly meta / planning.
  const pieces = t
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const spoken = pieces.filter(
    (s) => !isMetaLeak(s) && !/^\(likely meant/i.test(s)
  );

  if (spoken.length > 0) {
    const joined = spoken.join(' ').trim();
    if (joined && !isMetaLeak(joined)) {
      return joined;
    }
  }

  // Last ditch: take text after the last meta cue.
  const markers = [
    /need concise[^.?!]*[.?!]\s*/gi,
    /no greetings[^.?!]*[.?!]\s*/gi,
    /likely meant[^)]*\)\s*/gi,
    /caller said:[^.?!]*[.?!]\s*/gi,
    /natural phone style[^.?!]*[.?!]\s*/gi,
  ];
  let rest = t;
  for (const re of markers) {
    rest = rest.replace(re, ' ').trim();
  }
  rest = rest.replace(/^\*+|\*+$/g, '').trim();
  // Remove leftover parenthetical corrections.
  rest = rest.replace(/\([^)]*likely meant[^)]*\)/gi, ' ').trim();
  rest = rest.replace(/\s{2,}/g, ' ').trim();

  if (rest && !isMetaLeak(rest) && rest.length >= 12) {
    return rest;
  }
  return null;
}

module.exports = {
  isMetaLeak,
  toSpokenOnly,
};
