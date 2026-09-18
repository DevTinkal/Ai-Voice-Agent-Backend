'use strict';

/**
 * Lightweight company facts — patterns/answers loaded from agent.config.js.
 */

const agentConfig = require('../agent/agent.config');

function compilePattern(source) {
  return new RegExp(String(source), 'i');
}

function buildFacts() {
  /** @type {Record<string, { id: string, patterns: RegExp[], answer: string }>} */
  const facts = {};
  const list = Array.isArray(agentConfig.quickFacts)
    ? agentConfig.quickFacts
    : [];
  for (const item of list) {
    if (!item || !item.id || !item.answer) {
      continue;
    }
    const patterns = Array.isArray(item.patterns)
      ? item.patterns.map(compilePattern)
      : [];
    facts[item.id] = {
      id: String(item.id),
      patterns,
      answer: String(item.answer),
    };
  }
  return facts;
}

const FACTS = buildFacts();

const PROJECT_INQUIRY_RE = compilePattern(
  agentConfig.projectInquiryPattern ||
    '\\b(build|need|want|looking for|develop|create|hire|project|platform|app|website|saas|integration|estimate|budget|timeline)\\b'
);

/**
 * Returns true for project / consultative questions that must stay on Live free-form audio.
 */
function isProjectInquiry(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }
  return PROJECT_INQUIRY_RE.test(text);
}

/**
 * @param {string} utterance
 * @returns {{ id: string, answer: string } | null}
 */
function matchQuickFact(utterance) {
  if (!utterance || typeof utterance !== 'string') {
    return null;
  }
  const text = utterance.trim();
  if (!text) {
    return null;
  }
  if (
    isProjectInquiry(text) &&
    !/\b(who\s+is|ceo|cto|jaipur|headquarter)/i.test(text)
  ) {
    return null;
  }

  for (const fact of Object.values(FACTS)) {
    if (fact.patterns.some((p) => p.test(text))) {
      return { id: fact.id, answer: fact.answer };
    }
  }
  return null;
}

module.exports = {
  FACTS,
  matchQuickFact,
  isProjectInquiry,
};
