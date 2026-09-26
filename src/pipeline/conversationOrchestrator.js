'use strict';

const fs = require('fs');
const path = require('path');
const {
  TURN,
  classifyCallerTurn,
  shouldAnswer,
} = require('../services/conversationController');
const logger = require('../utils/logger');

const TURN_CTRL_LOG_PATH = path.join(__dirname, '../../logs/turn-ctrl-latest.log');
const ECHO_GUARD_MS = 2500;

function clearTurnCtrlLogOnStartup() {
  try {
    fs.mkdirSync(path.dirname(TURN_CTRL_LOG_PATH), { recursive: true });
    fs.writeFileSync(TURN_CTRL_LOG_PATH, '', 'utf8');
  } catch (error) {
    logger.warn('TURN_CTRL', `Failed to clear turn-ctrl log: ${error.message}`);
  }
}

function appendTurnCtrl(session, decision, action) {
  const raw = String((decision && decision.text) || '').trim();
  const words = raw ? raw.split(/\s+/).filter(Boolean).length : 0;
  const line =
    `${new Date().toISOString()} TURN_CTRL [TURN_CTRL]` +
    ` callSid=${(session && session.callSid) || '-'}` +
    ` class=${decision.class}` +
    ` reason=${decision.reason || '-'}` +
    ` action=${action}` +
    ` aiSpeaking=${Boolean(session && session.aiSpeaking)}` +
    ` waiting=${Boolean(session && (session.waiting || session.waitPhase === 'WAITING'))}` +
    ` words=${words} chars=${raw.length}` +
    ` text="${raw.slice(0, 60).replace(/"/g, "'")}"`;
  logger.info('TURN_CTRL', line);
  try {
    fs.mkdirSync(path.dirname(TURN_CTRL_LOG_PATH), { recursive: true });
    fs.appendFileSync(TURN_CTRL_LOG_PATH, `${line}\n`, 'utf8');
  } catch (error) {
    logger.warn('TURN_CTRL', `append failed: ${error.message}`);
  }
}

function isEchoGuardActive(session) {
  if (!session || !session.greeted) return false;
  const until = Number(session.classicEchoGuardUntil) || 0;
  if (until && Date.now() < until) return true;
  return false;
}

/**
 * Decide what the classic pipeline should do with a finished caller transcript.
 * @param {object} session
 * @param {string} text
 */
function decideTurn(session, text) {
  const waiting = Boolean(
    session && (session.waiting || session.waitPhase === 'WAITING')
  );
  const alreadyGreeted = Boolean(session && session.greeted);

  if (
    alreadyGreeted &&
    isEchoGuardActive(session) &&
    (session.greetingPlayedViaTwiml || session.greetingClipReady)
  ) {
    return {
      decision: {
        class: TURN.NOISE,
        reason: 'echo_guard_window',
        text: String(text || '').trim(),
      },
      action: 'DROP',
    };
  }

  const decision = classifyCallerTurn(text, {
    aiSpeaking: Boolean(session && session.aiSpeaking),
    waiting,
    alreadyGreeted,
    agentName: session && session.agentName,
  });
  let action = 'ANSWER';
  if (decision.class === TURN.NOISE) action = 'DROP';
  else if (decision.class === TURN.BACKCHANNEL) action = 'SKIP_BACKCHANNEL';
  else if (decision.class === TURN.INCOMPLETE) action = 'KEEP_LISTENING';
  else if (decision.class === TURN.WAIT) action = 'ENTER_WAIT';
  else if (decision.class === TURN.ACK_ONLY) action = 'ACK_ONLY';
  else if (shouldAnswer(decision.class)) action = waiting ? 'RESUME_AND_ANSWER' : 'ANSWER';
  return { decision, action };
}

module.exports = {
  TURN_CTRL_LOG_PATH,
  clearTurnCtrlLogOnStartup,
  appendTurnCtrl,
  decideTurn,
  isEchoGuardActive,
  ECHO_GUARD_MS,
};
