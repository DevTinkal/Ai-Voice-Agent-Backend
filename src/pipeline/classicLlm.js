'use strict';

const { GoogleGenAI } = require('@google/genai');
const { env } = require('../config/env');
const knowledgeService = require('../services/knowledgeService');
const logger = require('../utils/logger');

const SEARCH_TOOL = {
  functionDeclarations: [
    {
      name: 'searchKnowledge',
      description:
        'Search the indexed dashboard Agent Prompt for company facts, identity, products, policies, pricing, leadership, and operating rules. Required before answering company or which-company questions. Skip only for pure greetings that need no company detail, or WAIT. Query must state the caller CURRENT intent and entity.',
      parameters: {
        type: 'OBJECT',
        properties: {
          query: {
            type: 'STRING',
            description:
              "Concise search query for the caller's current meaning (include company/leadership terms when relevant).",
          },
        },
        required: ['query'],
      },
    },
  ],
};

const NEEDS_KNOWLEDGE_RE =
  /\b(compan(y|ies)|business|work(?:ing)?\s+for|ceo|founder|owner|president|price|pricing|cost|franchise|product|service|policy|policies|location|where\s+are\s+you|about\s+(?:your|the)\s+company)\b/i;

/** Name-only asks — answer from AGENT IDENTITY; do not force RAG. */
const NAME_ONLY_ASK_RE =
  /^(who\s+are\s+you|what(?:'s|\s+is)\s+your\s+name)[.?!]*$/i;

const EMPTY_KNOWLEDGE_SPEECH =
  "Yeah, I don't have that detail in my configured information right now, and I don't want to guess.";

function extractText(response) {
  if (!response) return '';
  if (typeof response.text === 'string' && response.text.trim()) {
    return response.text.trim();
  }
  const parts =
    response.candidates &&
    response.candidates[0] &&
    response.candidates[0].content &&
    response.candidates[0].content.parts;
  if (!Array.isArray(parts)) return '';
  return parts
    .map((p) => (p && p.text ? p.text : ''))
    .join('')
    .trim();
}

function functionCallsOf(response) {
  if (response && Array.isArray(response.functionCalls) && response.functionCalls.length) {
    return response.functionCalls;
  }
  const parts =
    response &&
    response.candidates &&
    response.candidates[0] &&
    response.candidates[0].content &&
    response.candidates[0].content.parts;
  if (!Array.isArray(parts)) return [];
  return parts
    .filter((p) => p && p.functionCall)
    .map((p) => p.functionCall);
}

function isNameOnlyAsk(userText) {
  return NAME_ONLY_ASK_RE.test(String(userText || '').trim());
}

function needsKnowledge(userText, forceKnowledge) {
  if (forceKnowledge) return true;
  const text = String(userText || '').trim();
  if (isNameOnlyAsk(text)) return false;
  return NEEDS_KNOWLEDGE_RE.test(text);
}

function formatSnippets(result) {
  if (!result || result.found === false) {
    return { found: false, snippets: [] };
  }
  const snippets = Array.isArray(result.snippets) ? result.snippets : [];
  const texts = snippets
    .map((s) => (typeof s === 'string' ? s : s && s.text))
    .filter(Boolean);
  return {
    found: Boolean(result.found) && texts.length > 0,
    snippets: texts,
    text: texts.join('\n\n'),
  };
}

/**
 * Gemini text turn with searchKnowledge. Blocked when waiting=true.
 * Auto-runs search when company/identity asks skip the tool.
 */
async function answerWithKnowledge(input) {
  const userText = String(input.userText || '').trim();
  if (!userText) return '';
  if (input.waiting) {
    logger.info('CLASSIC', 'searchKnowledge skipped waiting=true');
    return '';
  }
  if (input.signal && input.signal.aborted) return '';

  const history = Array.isArray(input.history) ? input.history : [];
  const contents = history
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content) }],
    }));
  contents.push({ role: 'user', parts: [{ text: userText }] });

  const generate =
    input.generateImpl ||
    (async (payload) => {
      const ai = new GoogleGenAI({ apiKey: env.geminiApiKey });
      return ai.models.generateContent(payload);
    });

  const searchImpl =
    input.searchImpl ||
    ((query) => knowledgeService.searchKnowledge(String(query), {}));

  const nameOnly = isNameOnlyAsk(userText) && !input.forceKnowledge;
  const tools = nameOnly ? [] : [SEARCH_TOOL];
  const maxOutputTokens = nameOnly ? 120 : 450;

  let didSearch = false;

  async function runSearch(query) {
    didSearch = true;
    const result = await searchImpl(query);
    return formatSnippets(result);
  }

  for (let hop = 0; hop < 3; hop += 1) {
    if (input.signal && input.signal.aborted) return '';
    const response = await generate({
      model: env.geminiModel || 'gemini-3.8-flash',
      contents,
      config: {
        systemInstruction: input.systemInstruction || '',
        tools,
        maxOutputTokens,
        abortSignal: input.signal,
      },
    });
    const calls = functionCallsOf(response);
    if (!calls.length) {
      let text = extractText(response);
      if (needsKnowledge(userText, input.forceKnowledge) && !didSearch) {
        const packed = await runSearch(userText);
        if (!packed.found) {
          if (input.forceKnowledge) {
            contents.push({
              role: 'user',
              parts: [
                {
                  text:
                    'searchKnowledge returned no useful company snippets. ' +
                    'Speak only using AGENT IDENTITY (configured agent name). ' +
                    'Do not invent a company, product, or reason for the call. ' +
                    'Keep 2–4 warm spoken sentences.',
                },
              ],
            });
            continue;
          }
          logger.info('CLASSIC', 'auto searchKnowledge empty — refuse invent');
          return EMPTY_KNOWLEDGE_SPEECH;
        }
        contents.push({
          role: 'user',
          parts: [
            {
              text:
                `searchKnowledge results (dashboard Agent Prompt only):\n${packed.text}\n\n` +
                'Speak a natural answer from these snippets only. Do not invent. Keep 2–5 long spoken sentences; acknowledge briefly if useful; one follow-up if natural.',
            },
          ],
        });
        continue;
      }
      return text;
    }
    if (nameOnly) {
      // Should not happen with tools disabled; ignore tool calls.
      return extractText(response);
    }
    const modelParts =
      (response.candidates &&
        response.candidates[0] &&
        response.candidates[0].content &&
        response.candidates[0].content.parts) ||
      calls.map((c) => ({ functionCall: c }));
    contents.push({ role: 'model', parts: modelParts });
    const responses = [];
    for (const call of calls) {
      if (call.name !== 'searchKnowledge') {
        responses.push({
          functionResponse: {
            name: call.name || 'unknown',
            response: { found: false, error: 'unsupported_tool' },
          },
        });
        continue;
      }
      const query =
        (call.args && call.args.query) ||
        (call.arguments && call.arguments.query) ||
        userText;
      const packed = await runSearch(query);
      responses.push({
        functionResponse: {
          name: 'searchKnowledge',
          response: packed.found
            ? { found: true, snippets: packed.snippets }
            : { found: false, snippets: [] },
        },
      });
    }
    contents.push({ role: 'user', parts: responses });
  }

  if (needsKnowledge(userText, input.forceKnowledge) && !didSearch) {
    return EMPTY_KNOWLEDGE_SPEECH;
  }
  return '';
}

module.exports = {
  answerWithKnowledge,
  extractText,
  functionCallsOf,
  needsKnowledge,
  isNameOnlyAsk,
  SEARCH_TOOL,
  EMPTY_KNOWLEDGE_SPEECH,
  NEEDS_KNOWLEDGE_RE,
  NAME_ONLY_ASK_RE,
};
