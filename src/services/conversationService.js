'use strict';

const { Message } = require('../models/Message');
const { isDatabaseConnected } = require('../config/database');
const callService = require('./callService');
const geminiService = require('./geminiService');
const dashboardSocket = require('../websocket/dashboardSocket');
const { isWaitHold, isResume } = require('../utils/waitIntent');
const { isMetaLeak, toSpokenOnly } = require('../utils/speechSanitize');
const logger = require('../utils/logger');

/**
 * @typedef {{
 *   ws: import('ws').WebSocket,
 *   callSid: string,
 *   sessionId: string|null,
 *   history: Array<{role: string, content: string}>,
 *   historyLoaded: boolean,
 *   waiting: boolean,
 *   waitAcknowledged: boolean,
 *   generationId: number,
 *   abortController: AbortController|null,
 *   lastAssistantText: string,
 * }} CallSession
 */

/** @type {Map<string, CallSession>} */
const sessions = new Map();

function registerSession(callSid, ws, sessionId) {
  const existing = sessions.get(callSid);
  sessions.set(callSid, {
    ws,
    callSid,
    sessionId: sessionId || null,
    history: existing && Array.isArray(existing.history) ? existing.history : [],
    historyLoaded: Boolean(existing && existing.historyLoaded),
    waiting: false,
    waitAcknowledged: false,
    generationId: 0,
    abortController: null,
    lastAssistantText: '',
  });
}

function getSession(callSid) {
  return sessions.get(callSid) || null;
}

function clearSession(callSid) {
  const session = sessions.get(callSid);
  if (session && session.abortController) {
    try {
      session.abortController.abort();
    } catch {
      // ignore
    }
  }
  sessions.delete(callSid);
}

function abortGeneration(session) {
  if (!session) {
    return;
  }
  if (session.abortController) {
    try {
      session.abortController.abort();
    } catch {
      // ignore
    }
  }
  session.abortController = null;
  session.generationId += 1;
}

function sendTextToRelay(ws, token, last = true) {
  if (!ws || ws.readyState !== 1) {
    return;
  }

  ws.send(
    JSON.stringify({
      type: 'text',
      token,
      last,
      interruptible: true,
      preemptible: true,
    })
  );
}

async function saveMessage(callSid, role, content) {
  if (!isDatabaseConnected()) {
    logger.warn('CALL', 'Skipping message save — database unavailable');
    return null;
  }

  try {
    const message = await Message.create({
      callSid,
      role,
      content,
      timestamp: new Date(),
    });
    return message;
  } catch (error) {
    logger.error('CALL', `Failed to save message: ${error.message}`);
    return null;
  }
}

function touchActivityAsync(callSid) {
  Promise.resolve()
    .then(() => callService.touchActivity(callSid))
    .catch((error) => {
      logger.error('CALL', `Async touchActivity failed: ${error.message}`);
    });
}

async function getConversationHistory(callSid, limit = 40) {
  if (!isDatabaseConnected()) {
    return [];
  }

  try {
    const messages = await Message.find({ callSid })
      .sort({ timestamp: 1 })
      .limit(limit)
      .lean();

    return messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role,
        content: m.content,
      }));
  } catch (error) {
    logger.error('CALL', `Failed to load history: ${error.message}`);
    return [];
  }
}

/**
 * MongoDB is the source of truth. Load into session cache when missing/stale.
 */
async function getOrLoadHistory(session) {
  if (!session) {
    return [];
  }

  if (session.historyLoaded && Array.isArray(session.history)) {
    return session.history;
  }

  const fromDb = await getConversationHistory(session.callSid);
  session.history = fromDb;
  session.historyLoaded = true;
  return session.history;
}

/**
 * Persist interrupt truncation: update latest assistant doc, or create one
 * when the stream was aborted before the first save.
 */
async function upsertTruncatedAssistantMessage(callSid, truncatedContent) {
  if (!isDatabaseConnected() || !truncatedContent) {
    return null;
  }

  try {
    const latest = await Message.findOne({ callSid, role: 'assistant' }).sort({
      timestamp: -1,
    });

    if (latest) {
      latest.content = truncatedContent;
      await latest.save();
      return latest;
    }

    return await Message.create({
      callSid,
      role: 'assistant',
      content: truncatedContent,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(
      'CALL',
      `Failed to upsert truncated assistant message: ${error.message}`
    );
    return null;
  }
}

function truncateAssistantHistory(session, utteranceUntilInterrupt) {
  if (!session) {
    return '';
  }

  const utterance =
    typeof utteranceUntilInterrupt === 'string' ? utteranceUntilInterrupt : '';

  if (!Array.isArray(session.history) || session.history.length === 0) {
    if (session.lastAssistantText) {
      let truncated = session.lastAssistantText.trim();
      if (utterance) {
        const pos = session.lastAssistantText.indexOf(utterance);
        if (pos !== -1) {
          truncated = session.lastAssistantText
            .substring(0, pos + utterance.length)
            .trim();
        }
      }
      session.lastAssistantText = truncated;
      session.history = [{ role: 'assistant', content: truncated }];
      session.historyLoaded = true;
      return truncated;
    }
    return '';
  }

  let interruptedIndex = -1;
  for (let i = session.history.length - 1; i >= 0; i -= 1) {
    const entry = session.history[i];
    if (entry.role !== 'assistant') {
      continue;
    }
    if (!utterance) {
      interruptedIndex = i;
      break;
    }
    if (entry.content.includes(utterance)) {
      interruptedIndex = i;
      break;
    }
  }

  if (interruptedIndex === -1) {
    // Mid-stream: assistant not yet committed to history.
    if (session.lastAssistantText) {
      let truncated = session.lastAssistantText.trim();
      if (utterance) {
        const pos = session.lastAssistantText.indexOf(utterance);
        if (pos !== -1) {
          truncated = session.lastAssistantText
            .substring(0, pos + utterance.length)
            .trim();
        }
      }
      session.lastAssistantText = truncated;
      session.history.push({ role: 'assistant', content: truncated });
      return truncated;
    }
    return '';
  }

  const interruptedMessage = session.history[interruptedIndex];
  let truncatedContent = interruptedMessage.content;

  if (utterance) {
    const interruptPosition = interruptedMessage.content.indexOf(utterance);
    if (interruptPosition !== -1) {
      truncatedContent = interruptedMessage.content
        .substring(0, interruptPosition + utterance.length)
        .trim();
    }
  }

  session.history[interruptedIndex] = {
    ...interruptedMessage,
    content: truncatedContent,
  };

  session.history = session.history.filter(
    (entry, index) =>
      !(index > interruptedIndex && entry.role === 'assistant')
  );

  session.lastAssistantText = truncatedContent;
  return truncatedContent;
}

async function handleSetup(ws, message) {
  const callSid = message.callSid;
  if (!callSid) {
    logger.warn('WS', 'Setup missing callSid');
    return;
  }

  registerSession(callSid, ws, message.sessionId || null);
  ws.callSid = callSid;

  const session = getSession(callSid);
  if (session) {
    session.history = await getConversationHistory(callSid);
    session.historyLoaded = true;
  }

  await callService.createCall({
    callSid,
    from: message.from,
    to: message.to,
    status: 'connected',
    direction: message.direction || 'inbound',
  });

  await callService.markAnswered(callSid, message.sessionId);

  dashboardSocket.broadcast({
    type: 'CALL_CONNECTED',
    data: {
      callSid,
      from: message.from,
      to: message.to,
      status: 'connected',
      sessionId: message.sessionId || null,
    },
  });

  logger.info('WS', `Setup received for ${callSid}`);
}

async function handleWaitHold(session, callSid, voicePrompt) {
  // Control command: abort speech/generation and stay silent — never call Gemini.
  abortGeneration(session);
  logger.info('VOICE', `wait command detected callSid=${callSid}`);
  logger.info('AI', `stream aborted callSid=${callSid} reason=wait`);

  session.waiting = true;
  session.waitAcknowledged = true;

  // Persist caller wait for transcript; do NOT speak or save an assistant ack.
  saveMessage(callSid, 'user', voicePrompt).catch((error) => {
    logger.error('CALL', `Wait user save failed: ${error.message}`);
  });
  if (Array.isArray(session.history)) {
    session.history.push({ role: 'user', content: voicePrompt });
    session.historyLoaded = true;
  }
  touchActivityAsync(callSid);

  dashboardSocket.broadcast({
    type: 'CALLER_MESSAGE',
    data: {
      callSid,
      content: voicePrompt,
    },
  });

  dashboardSocket.broadcast({
    type: 'AI_WAITING',
    data: {
      callSid,
      reason: 'caller_hold',
    },
  });

  logger.info('VOICE', `wait silence — no Gemini, no TTS ack callSid=${callSid}`);
}

/**
 * True when model output is truncated, hanging, or an internal meta leak —
 * not safe to save / show as a completed assistant turn.
 * Keep this STRICT — false positives cause a second Gemini call and kill latency.
 * @param {string} text
 */
function isIncompleteUtterance(text) {
  const t = String(text || '').trim();
  if (!t) {
    return true;
  }

  if (isMetaLeak(t)) {
    return true;
  }

  if (/^Current state:/i.test(t) || /Current state:/i.test(t)) {
    return true;
  }
  if (/violating the/i.test(t)) {
    return true;
  }
  if (/the user is asking/i.test(t)) {
    return true;
  }

  if (/[,…]$/.test(t) || /\.\.\.$/.test(t)) {
    return true;
  }

  const hangingWhole =
    /^(i am|i'?m|i'?m doing|to start|good (morning|afternoon|evening),?|hello,?|hi,?)$/i;
  if (hangingWhole.test(t)) {
    return true;
  }

  if (/\b(i am|i'?m doing|to start)$/i.test(t)) {
    return true;
  }

  // Only treat tiny no-punctuation scraps as incomplete (not normal short replies).
  if (t.length < 12 && !/[.!?]"?$/.test(t)) {
    return true;
  }

  return false;
}

/**
 * Resolve stream text into a safe spoken reply, or null if unusable.
 * @param {string} text
 */
function resolveSpokenText(text) {
  const t = String(text || '').trim();
  if (!t) {
    return null;
  }
  if (isMetaLeak(t)) {
    return toSpokenOnly(t);
  }
  if (isIncompleteUtterance(t)) {
    return null;
  }
  return t;
}

/**
 * Second Gemini call only for true meta leak / empty / hard hang — never for normal replies.
 * @param {string} text
 * @param {boolean} alreadySpoken
 */
function shouldRetryGeneration(text, alreadySpoken) {
  if (alreadySpoken) {
    return false;
  }
  const t = String(text || '').trim();
  if (!t) {
    return true;
  }
  if (isMetaLeak(t)) {
    const recovered = toSpokenOnly(t);
    return !recovered || isIncompleteUtterance(recovered);
  }
  return isIncompleteUtterance(t);
}

async function streamAssistantReply(session, callSid, userText, timing = {}) {
  abortGeneration(session);
  const generationId = session.generationId;
  const abortController = new AbortController();
  session.abortController = abortController;

  const speechReceivedAt = timing.speechReceivedAt || Date.now();

  // History should already be warm from handlePrompt; only hit Mongo if cold.
  if (!session.historyLoaded) {
    await getOrLoadHistory(session);
  }

  session.history.push({ role: 'user', content: userText });
  session.historyLoaded = true;
  session.lastAssistantText = '';

  // Non-critical: never block Gemini TTFT.
  touchActivityAsync(callSid);
  callService.markInProgress(callSid).catch((error) => {
    logger.error('CALL', `markInProgress failed: ${error.message}`);
  });
  const userSavePromise = saveMessage(callSid, 'user', userText);
  dashboardSocket.broadcast({
    type: 'CALLER_MESSAGE',
    data: { callSid, content: userText },
  });
  dashboardSocket.broadcast({
    type: 'AI_PROCESSING',
    data: { callSid },
  });

  let fullText = '';
  let sentLast = false;
  let completedCleanly = false;
  let streamError = null;
  let tokensSentToRelay = false;
  let suppressRelay = false;
  let geminiRequestCount = 1;
  const requestStartedAt = Date.now();
  let firstGeminiTokenAt = null;
  let firstRelayTokenAt = null;

  logger.info(
    'AI',
    `Gemini request started callSid=${callSid} speech_to_request_ms=${requestStartedAt - speechReceivedAt}`
  );

  function closeUtterance() {
    if (sentLast) {
      return;
    }
    sendTextToRelay(session.ws, '', true);
    sentLast = true;
    logger.info('AI', 'final token sent (closer)');
  }

  function sendTokenNow(token, isLast) {
    const text = token == null ? '' : String(token);
    if (!text && !isLast) {
      return;
    }
    sendTextToRelay(session.ws, text, isLast);
    if (text) {
      tokensSentToRelay = true;
      if (firstRelayTokenAt == null) {
        firstRelayTokenAt = Date.now();
        logger.info(
          'AI',
          `first clean spoken text sent to ConversationRelay: ${firstRelayTokenAt - requestStartedAt}ms (Gemini first token: ${firstGeminiTokenAt != null ? firstGeminiTokenAt - requestStartedAt : 'n/a'}ms)`
        );
      }
      logger.info(
        'AI',
        isLast
          ? `final token sent len=${text.length}`
          : `token sent len=${text.length}`
      );
    } else if (isLast) {
      logger.info('AI', 'final token sent (closer)');
    }
    if (isLast) {
      sentLast = true;
    }
  }

  function broadcastStreaming() {
    dashboardSocket.broadcast({
      type: 'AI_STREAMING',
      data: {
        callSid,
        content: fullText,
      },
    });
  }

  function stillActive() {
    return (
      generationId === session.generationId &&
      !abortController.signal.aborted
    );
  }

  try {
    for await (const chunk of geminiService.generateResponseStream(
      session.history,
      { abortSignal: abortController.signal }
    )) {
      if (!stillActive()) {
        logger.info('AI', `stream aborted callSid=${callSid}`);
        if (tokensSentToRelay && !sentLast) {
          closeUtterance();
        }
        userSavePromise.catch(() => null);
        return;
      }

      if (chunk.token) {
        if (firstGeminiTokenAt == null) {
          firstGeminiTokenAt = Date.now();
          logger.info(
            'AI',
            `first Gemini text received: ${firstGeminiTokenAt - requestStartedAt}ms`
          );
        }
        logger.info('AI', `chunk received len=${chunk.token.length}`);
        fullText += chunk.token;
        session.lastAssistantText = fullText;

        // Only suppress on clear meta leak (not incomplete heuristics mid-stream).
        if (isMetaLeak(fullText) || isMetaLeak(chunk.token)) {
          suppressRelay = true;
          logger.info('AI', 'meta leak detected mid-stream — suppressing TTS');
        }

        if (!suppressRelay) {
          if (chunk.last) {
            sendTokenNow(chunk.token, true);
          } else {
            sendTokenNow(chunk.token, false);
          }
          broadcastStreaming();
        }
      }
    }

    if (!stillActive()) {
      logger.info('AI', `stream aborted callSid=${callSid}`);
      if (tokensSentToRelay && !sentLast) {
        closeUtterance();
      }
      userSavePromise.catch(() => null);
      return;
    }

    const streamCompletedAt = Date.now();
    logger.info(
      'AI',
      `Gemini stream completed: ${streamCompletedAt - requestStartedAt}ms callSid=${callSid}`
    );

    fullText = (fullText || '').trim();
    const isLeak = isMetaLeak(fullText);
    const spokenResolved = resolveSpokenText(fullText);

    if (shouldRetryGeneration(fullText, tokensSentToRelay)) {
      logger.info(
        'AI',
        `retry warranted leak=${isLeak} spoken=${tokensSentToRelay} len=${fullText.length}`
      );

      if (tokensSentToRelay) {
        closeUtterance();
        completedCleanly = false;
        fullText = '';
      } else if (spokenResolved && !isIncompleteUtterance(spokenResolved) && !isMetaLeak(spokenResolved)) {
        fullText = spokenResolved;
        sendTokenNow(fullText, true);
        broadcastStreaming();
        completedCleanly = true;
      } else {
        geminiRequestCount = 2;
        logger.info('AI', `second Gemini request (anti-leak/incomplete only) callSid=${callSid}`);
        const retry = await geminiService.generateResponse(
          [
            ...session.history,
            {
              role: 'user',
              content:
                'Reply with ONLY the words I should hear spoken aloud. One or two complete sentences. Do not write Caller said, likely meant, Need concise, planning notes, or markdown.',
            },
          ],
          { abortSignal: abortController.signal, maxModels: 1 }
        );

        if (!stillActive() || (retry && retry.aborted)) {
          logger.info('AI', `stream aborted callSid=${callSid}`);
          userSavePromise.catch(() => null);
          return;
        }

        let retryText = retry && retry.text ? String(retry.text).trim() : '';
        retryText = resolveSpokenText(retryText) || '';
        if (
          retryText &&
          !isIncompleteUtterance(retryText) &&
          !isMetaLeak(retryText)
        ) {
          fullText = retryText;
        } else {
          fullText = geminiService.FALLBACK_SPEECH;
        }

        sendTokenNow(fullText, true);
        broadcastStreaming();
        completedCleanly =
          !isIncompleteUtterance(fullText) && !isMetaLeak(fullText);
      }
    } else if (isLeak && spokenResolved && !tokensSentToRelay) {
      // Leak with recoverable spoken text — speak recovered, no second request.
      fullText = spokenResolved;
      sendTokenNow(fullText, true);
      broadcastStreaming();
      completedCleanly = true;
      logger.info('AI', 'meta leak recovered without retry');
    } else if (fullText && spokenResolved) {
      fullText = spokenResolved;
      if (!sentLast) {
        closeUtterance();
      }
      completedCleanly = true;
    } else if (fullText && tokensSentToRelay && !isLeak) {
      // Already spoken a normal reply — do not retry; close and save.
      if (!sentLast) {
        closeUtterance();
      }
      completedCleanly = !isIncompleteUtterance(fullText);
    } else {
      completedCleanly = false;
    }
  } catch (error) {
    if (!stillActive()) {
      logger.info('AI', `stream aborted callSid=${callSid}`);
      userSavePromise.catch(() => null);
      return;
    }
    streamError = error;
    logger.error('AI', `handler error: ${error.message}`);
    if (!sentLast && !tokensSentToRelay) {
      const fallback = geminiService.FALLBACK_SPEECH;
      sendTokenNow(fallback, true);
      fullText = fallback;
      completedCleanly = true;
    } else if (tokensSentToRelay && !sentLast) {
      closeUtterance();
      completedCleanly = false;
    } else {
      completedCleanly = false;
    }
  }

  userSavePromise.catch((error) => {
    logger.error('CALL', `User message save failed: ${error.message}`);
  });

  if (!stillActive()) {
    logger.info('AI', `stream aborted callSid=${callSid}`);
    return;
  }

  fullText = (fullText || '').trim();

  if (
    !completedCleanly ||
    !fullText ||
    isIncompleteUtterance(fullText) ||
    isMetaLeak(fullText)
  ) {
    logger.info(
      'AI',
      `skipped save reason=incomplete_or_meta gemini_requests=${geminiRequestCount} sentLast=${sentLast} spoken=${tokensSentToRelay} err=${streamError ? streamError.message : 'none'}`
    );
    session.abortController = null;
    return;
  }

  session.lastAssistantText = fullText;
  // Persist after TTS already started — do not block the caller's ears.
  saveMessage(callSid, 'assistant', fullText)
    .then(() => {
      logger.info(
        'AI',
        `response saved callSid=${callSid} len=${fullText.length} gemini_requests=${geminiRequestCount} total_generation=${Date.now() - requestStartedAt}ms`
      );
    })
    .catch((error) => {
      logger.error('CALL', `Assistant message save failed: ${error.message}`);
    });
  session.history.push({ role: 'assistant', content: fullText });
  touchActivityAsync(callSid);

  logger.info(
    'AI',
    `complete response callSid=${callSid} len=${fullText.length} gemini_requests=${geminiRequestCount} total_generation=${Date.now() - requestStartedAt}ms`
  );

  dashboardSocket.broadcast({
    type: 'AI_RESPONSE',
    data: {
      callSid,
      content: fullText,
    },
  });

  session.abortController = null;
}

async function handlePrompt(ws, message) {
  const callSid = ws.callSid;
  const speechReceivedAt = Date.now();
  if (!callSid) {
    logger.warn('WS', 'Prompt received without call session');
    return;
  }

  if (message.last === false) {
    return;
  }

  const voicePrompt =
    typeof message.voicePrompt === 'string' ? message.voicePrompt.trim() : '';

  if (!voicePrompt) {
    logger.warn('WS', 'Empty prompt ignored');
    return;
  }

  logger.info(
    'VOICE',
    `user utterance received callSid=${callSid} len=${voicePrompt.length}`
  );

  let session = getSession(callSid);
  if (!session) {
    registerSession(callSid, ws, null);
    session = getSession(callSid);
  } else {
    session.ws = ws;
  }

  // Never start a turn with empty RAM history — reload from Mongo.
  await getOrLoadHistory(session);

  if (isWaitHold(voicePrompt)) {
    await handleWaitHold(session, callSid, voicePrompt);
    return;
  }

  let userText = voicePrompt;

  if (session.waiting) {
    session.waiting = false;
    session.waitAcknowledged = false;

    if (isResume(voicePrompt)) {
      userText = 'Please continue.';
    }
  }

  await streamAssistantReply(session, callSid, userText, { speechReceivedAt });
}

async function handleInterrupt(ws, message) {
  const callSid = ws.callSid;
  logger.info('VOICE', `interrupt detected callSid=${callSid || 'unknown'}`);

  if (!callSid) {
    return;
  }

  let truncated = '';
  let persisted = false;
  const utteranceUntilInterrupt =
    typeof message.utteranceUntilInterrupt === 'string'
      ? message.utteranceUntilInterrupt.trim()
      : '';

  const session = getSession(callSid);
  if (session) {
    abortGeneration(session);
    logger.info('AI', `stream aborted callSid=${callSid} reason=interrupt`);

    // Keep RAM context for barge-in, but do not create Mongo fragment spam.
    if (utteranceUntilInterrupt.length >= 12) {
      truncated = truncateAssistantHistory(session, utteranceUntilInterrupt);
      // Intentionally do NOT upsert a new assistant Message for interrupt fragments.
      // Completed turns are saved only after a clean stream finish.
      persisted = false;
      if (truncated) {
        session.lastAssistantText = truncated;
        logger.info(
          'AI',
          `interrupt truncated in-memory len=${truncated.length} persisted=false`
        );
      }
    } else {
      logger.info(
        'AI',
        `interrupt without meaningful utterance for ${callSid} — abort only`
      );
    }
  }

  dashboardSocket.broadcast({
    type: 'CALL_INTERRUPT',
    data: {
      callSid,
      utteranceUntilInterrupt,
      // Never promote interrupt partials to completed AI on the dashboard.
      truncatedContent: '',
      persisted,
    },
  });
}

async function handleError(ws, message) {
  logger.error(
    'WS',
    `ConversationRelay error: ${message.description || 'unknown'}`
  );

  const callSid = ws.callSid;
  if (callSid) {
    await callService.markFailed(callSid);
  }
}

async function handleClose(ws) {
  const callSid = ws.callSid;
  logger.info('WS', 'ConversationRelay disconnected');

  if (!callSid) {
    return;
  }

  const call = await callService.markCompleted(callSid);
  clearSession(callSid);

  dashboardSocket.broadcast({
    type: 'CALL_COMPLETED',
    data: {
      callSid,
      status: 'completed',
      duration: call ? call.duration : null,
    },
  });
}

async function getMessagesForCall(callSid) {
  if (!isDatabaseConnected()) {
    return [];
  }

  try {
    return await Message.find({ callSid }).sort({ timestamp: 1 }).lean();
  } catch (error) {
    logger.error('CALL', `Failed to get messages: ${error.message}`);
    return [];
  }
}

function clearAllSessions() {
  for (const session of sessions.values()) {
    if (session.abortController) {
      try {
        session.abortController.abort();
      } catch {
        // ignore
      }
    }
  }
  sessions.clear();
}

module.exports = {
  registerSession,
  getSession,
  clearSession,
  clearAllSessions,
  sendTextToRelay,
  handleSetup,
  handlePrompt,
  handleInterrupt,
  handleError,
  handleClose,
  getConversationHistory,
  getMessagesForCall,
  saveMessage,
  getOrLoadHistory,
};
