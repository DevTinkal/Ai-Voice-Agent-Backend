'use strict';

/**
 * Lightweight in-memory verified company facts for fast phone answers.
 */

const FACTS = {
  ceo: {
    id: 'ceo',
    patterns: [
      /\b(who\s+is|who's)\s+(the\s+)?(ceo|founder)\b/i,
      /\b(ceo|founder)\s+of\s+jploft\b/i,
      /\btell\s+me\s+about\s+(the\s+)?(ceo|founder|rahul)\b/i,
      /\brahul\s+sukhwal\b/i,
    ],
    answer:
      'Rahul Sukhwal is the Founder, Director and CEO of JPLoft. He has over 18 years of industry experience and has grown the company from a startup into a global software development company.',
  },
  cto: {
    id: 'cto',
    patterns: [
      /\b(who\s+is|who's)\s+(the\s+)?cto\b/i,
      /\bcto\s+of\s+jploft\b/i,
      /\btell\s+me\s+about\s+(the\s+)?(cto|yashwant)\b/i,
      /\byashwant\s+sharma\b/i,
    ],
    answer:
      "Yashwant Sharma is the Chief Technology Officer of JPLoft. He has over 14 years of industry experience and brings strong technical expertise and leadership to the company. He is responsible for overseeing the development and implementation of cutting-edge technologies, helping ensure JPLoft's solutions remain scalable and secure.",
  },
  whatWeDo: {
    id: 'whatWeDo',
    patterns: [
      /\bwhat\s+(does|do)\s+jploft\s+do\b/i,
      /\bwhat\s+is\s+jploft\b/i,
      /\btell\s+me\s+about\s+jploft\b/i,
      /\bwhat\s+services\s+(do\s+you|does\s+jploft)\s+offer\b/i,
    ],
    answer:
      'JPLoft builds custom software, mobile apps, web platforms, AI solutions, SaaS products, and enterprise systems for businesses.',
  },
  jaipur: {
    id: 'jaipur',
    patterns: [
      /\b(where\s+is|what's|what\s+is)\s+(your\s+)?jaipur\s+(office|center|centre|location)\b/i,
      /\bjaipur\s+(office|development\s+center|address)\b/i,
      /\b(office|address)\s+in\s+jaipur\b/i,
    ],
    answer:
      'Our Jaipur Development Center is at E-191 C, RIICO Industrial Area, Mansarovar, Jaipur, Rajasthan. It is a development center, not our headquarters.',
  },
  hq: {
    id: 'hq',
    patterns: [
      /\bwhere\s+(is|are)\s+(jploft|you)\s+(headquartered|based)\b/i,
      /\b(head\s*office|headquarters|hq)\b/i,
      /\bprimary\s+office\b/i,
    ],
    answer:
      'JPLoft\'s primary office is in Denver at 700 North Colorado Boulevard, Suite 200. Our Jaipur location is a development center.',
  },
};

/**
 * Returns null for project / consultative questions that must stay on Live free-form audio.
 */
function isProjectInquiry(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }
  return /\b(build|need|want|looking for|develop|create|hire|project|platform|app|website|saas|integration|estimate|budget|timeline)\b/i.test(
    text
  );
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
  if (isProjectInquiry(text) && !/\b(who\s+is|ceo|cto|jaipur|headquarter)/i.test(text)) {
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
