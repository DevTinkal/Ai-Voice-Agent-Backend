'use strict';

const fs = require('fs');
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const liveCallSession = require('../src/services/liveCallSession');
const logger = require('../src/utils/logger');

/** Attach matching turn-seq fields so stamps pass same-turn checks. */
function withTurnSeq(session, seq = 1) {
  session.latencyTurnSeq = seq;
  session.speechTurnSeq = seq;
  session.turnCompleteTurnSeq = seq;
  session.firstAudioTurnSeq =
    session.turnGeminiFirstAudioAt != null ? seq : null;
  session.twilioSendTurnSeq =
    session.turnTwilioFirstSendAt != null ? seq : null;
  return session;
}

function assertAbcEqualsTotal(message) {
  const a = Number(
    message.match(/user_stop_to_gemini_turn_complete=(\d+)ms/)[1]
  );
  const b = Number(
    message.match(/gemini_turn_complete_to_first_audio=(\d+)ms/)[1]
  );
  const c = Number(
    message.match(/first_audio_to_twilio_send=(\d+)ms/)[1]
  );
  const total = Number(
    message.match(/TOTAL_user_stop_to_twilio_send=(\d+)ms/)[1]
  );
  assert.equal(a + b + c, total);
}

describe('LATENCY_BREAKDOWN', () => {
  afterEach(() => {
    liveCallSession.setNowMsForTests(null);
  });

  it('logs measured deltas and skips incomplete turns', () => {
    const lines = [];
    const originalInfo = logger.info;
    logger.info = (tag, message) => {
      lines.push({ tag, message });
    };

    try {
      const incomplete = withTurnSeq({
        callSid: 'CA_INCOMPLETE',
        lastSpeechAudioAt: 1000,
        geminiUserTurnCompleteAt: 1300,
        turnGeminiFirstAudioAt: null,
        turnTwilioFirstSendAt: null,
        latencyBreakdownLogged: false,
      });
      assert.equal(liveCallSession.maybeLogLatencyBreakdown(incomplete), false);
      assert.equal(lines.length, 0);

      const session = withTurnSeq({
        callSid: 'CA_LAT',
        lastSpeechAudioAt: 1000,
        geminiUserTurnCompleteAt: 1350,
        turnGeminiFirstAudioAt: 2100,
        turnTwilioFirstSendAt: 2140,
        latencyBreakdownLogged: false,
      });
      assert.equal(liveCallSession.maybeLogLatencyBreakdown(session), true);
      assert.equal(session.latencyBreakdownLogged, true);

      const breakdown = lines.find((l) => l.tag === 'LATENCY_BREAKDOWN');
      assert.ok(breakdown);
      assert.match(
        breakdown.message,
        /call=CA_LAT turn=1 model=\S+ user_stop_to_gemini_turn_complete=350ms gemini_turn_complete_to_first_audio=750ms first_audio_to_twilio_send=40ms TOTAL_user_stop_to_twilio_send=1140ms/
      );
      assertAbcEqualsTotal(breakdown.message);

      assert.equal(liveCallSession.maybeLogLatencyBreakdown(session), false);
    } finally {
      logger.info = originalInfo;
    }
  });

  it('playGeminiPcmOnce stamps first audio and twilio send then logs breakdown', () => {
    let t = 5000;
    liveCallSession.setNowMsForTests(() => t);

    const lines = [];
    const originalInfo = logger.info;
    logger.info = (tag, message) => {
      lines.push({ tag, message });
    };

    try {
      const session = withTurnSeq({
        callSid: 'CA_PIPE',
        streamSid: 'MZ_PIPE',
        waiting: false,
        ending: false,
        playbackGeneration: 0,
        geminiChunkCount: 0,
        twilioFrameCount: 0,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        aiSpeaking: false,
        turnFirstAudioLogged: false,
        t0: 4000,
        lastSpeechAudioAt: 1000,
        geminiUserTurnCompleteAt: 1400,
        turnGeminiFirstAudioAt: null,
        turnTwilioFirstSendAt: null,
        latencyBreakdownLogged: false,
        lastUserTurnEndAt: 1400,
        firstGeminiAudioAt: null,
        firstTwilioOutAt: null,
        twilioWs: {
          readyState: 1,
          send() {},
        },
      });
      // first audio / twilio seq assigned when playGeminiPcmOnce runs
      session.firstAudioTurnSeq = null;
      session.twilioSendTurnSeq = null;

      liveCallSession.playGeminiPcmOnce(
        session,
        Buffer.alloc(480 * 2),
        session.playbackGeneration
      );

      assert.equal(session.turnGeminiFirstAudioAt, 5000);
      assert.equal(session.turnTwilioFirstSendAt, 5000);
      assert.equal(session.firstAudioTurnSeq, 1);
      assert.equal(session.twilioSendTurnSeq, 1);
      assert.equal(session.latencyBreakdownLogged, true);

      const breakdown = lines.find((l) => l.tag === 'LATENCY_BREAKDOWN');
      assert.ok(breakdown);
      assert.match(
        breakdown.message,
        /user_stop_to_gemini_turn_complete=400ms gemini_turn_complete_to_first_audio=3600ms first_audio_to_twilio_send=0ms TOTAL_user_stop_to_twilio_send=4000ms/
      );
      assertAbcEqualsTotal(breakdown.message);
    } finally {
      logger.info = originalInfo;
      liveCallSession.setNowMsForTests(null);
    }
  });

  it('greeting Twilio stamp does not block a later user-turn breakdown', () => {
    let t = 1000;
    liveCallSession.setNowMsForTests(() => t);

    const lines = [];
    const originalInfo = logger.info;
    logger.info = (tag, message) => {
      lines.push({ tag, message });
    };

    try {
      const session = {
        callSid: 'CA_MULTI',
        streamSid: 'MZ_MULTI',
        waiting: false,
        ending: false,
        playbackGeneration: 0,
        geminiChunkCount: 0,
        twilioFrameCount: 0,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        aiSpeaking: false,
        turnFirstAudioLogged: false,
        t0: 0,
        lastSpeechAudioAt: null,
        geminiUserTurnCompleteAt: null,
        turnGeminiFirstAudioAt: null,
        turnTwilioFirstSendAt: null,
        latencyTurnSeq: 0,
        speechTurnSeq: null,
        turnCompleteTurnSeq: null,
        firstAudioTurnSeq: null,
        twilioSendTurnSeq: null,
        latencyBreakdownLogged: false,
        lastUserTurnEndAt: null,
        firstGeminiAudioAt: null,
        firstTwilioOutAt: null,
        twilioWs: { readyState: 1, send() {} },
      };

      // Greeting audio (no user speech yet) — incomplete, must not stick.
      liveCallSession.playGeminiPcmOnce(
        session,
        Buffer.alloc(480 * 2),
        session.playbackGeneration
      );
      // Greeting has no open user window (seq 0) → first audio may stamp with null seq
      assert.equal(session.latencyBreakdownLogged, false);

      // Model turn complete → outbound stamps cleared.
      liveCallSession.handleLiveMessage(
        session,
        { serverContent: { turnComplete: true } },
        null
      );
      assert.equal(session.turnFirstAudioLogged, false);
      assert.equal(session.turnTwilioFirstSendAt, null);
      assert.equal(session.turnGeminiFirstAudioAt, null);

      // User spoke and Gemini closed the user turn.
      t = 5000;
      liveCallSession.beginNewUserLatencyWindow(session);
      session.lastSpeechAudioAt = 4500;
      session.speechTurnSeq = session.latencyTurnSeq;
      session.geminiUserTurnCompleteAt = 4800;
      session.turnCompleteTurnSeq = session.latencyTurnSeq;
      session.lastUserTurnEndAt = 4800;

      // Reply audio for turn 2.
      t = 6000;
      liveCallSession.playGeminiPcmOnce(
        session,
        Buffer.alloc(480 * 2),
        session.playbackGeneration
      );

      assert.equal(session.latencyBreakdownLogged, true);
      const breakdowns = lines.filter((l) => l.tag === 'LATENCY_BREAKDOWN');
      assert.equal(breakdowns.length, 1);
      assert.match(
        breakdowns[0].message,
        /user_stop_to_gemini_turn_complete=300ms gemini_turn_complete_to_first_audio=1200ms/
      );
      assertAbcEqualsTotal(breakdowns[0].message);

      assert.ok(fs.existsSync(liveCallSession.LATENCY_LOG_PATH));
    } finally {
      logger.info = originalInfo;
      liveCallSession.setNowMsForTests(null);
    }
  });

  it('AI turnComplete after breakdown does not reuse stale turnComplete (A+B+C===TOTAL)', () => {
    let t = 0;
    liveCallSession.setNowMsForTests(() => t);

    const lines = [];
    const originalInfo = logger.info;
    logger.info = (tag, message) => {
      lines.push({ tag, message });
    };

    try {
      const session = withTurnSeq({
        callSid: 'CA_STALE_FIX',
        streamSid: 'MZ_STALE',
        waiting: false,
        ending: false,
        playbackGeneration: 0,
        geminiChunkCount: 0,
        twilioFrameCount: 0,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        aiSpeaking: false,
        turnFirstAudioLogged: false,
        t0: 0,
        lastSpeechAudioAt: 1000,
        geminiUserTurnCompleteAt: 1400,
        turnGeminiFirstAudioAt: null,
        turnTwilioFirstSendAt: null,
        latencyBreakdownLogged: false,
        latencyBreakdownIncompleteLogged: false,
        lastUserTurnEndAt: 1400,
        firstGeminiAudioAt: null,
        firstTwilioOutAt: null,
        speechGate: null,
        forwardAudio: true,
        liveSession: { mock: true },
        twilioWs: { readyState: 1, send() {} },
      });
      session.firstAudioTurnSeq = null;
      session.twilioSendTurnSeq = null;

      // Turn 1 reply audio → valid breakdown.
      t = 1800;
      liveCallSession.playGeminiPcmOnce(
        session,
        Buffer.alloc(480 * 2),
        session.playbackGeneration
      );
      assert.equal(session.latencyBreakdownLogged, true);

      // AI turnComplete must NOT clear latencyBreakdownLogged (the bug).
      liveCallSession.handleLiveMessage(
        session,
        { serverContent: { turnComplete: true } },
        null
      );
      assert.equal(session.latencyBreakdownLogged, true);
      assert.equal(session.turnTwilioFirstSendAt, null);

      // Next user speech opens a fresh window (clears stale turnComplete).
      t = 20000;
      liveCallSession.beginNewUserLatencyWindow(session);
      session.lastSpeechAudioAt = 20000;
      session.speechTurnSeq = session.latencyTurnSeq;
      assert.equal(session.geminiUserTurnCompleteAt, null);
      assert.equal(session.latencyBreakdownLogged, false);

      t = 20400;
      session.geminiUserTurnCompleteAt = 20400;
      session.turnCompleteTurnSeq = session.latencyTurnSeq;
      session.lastUserTurnEndAt = 20400;

      t = 21000;
      liveCallSession.playGeminiPcmOnce(
        session,
        Buffer.alloc(480 * 2),
        session.playbackGeneration
      );

      const breakdowns = lines.filter((l) => l.tag === 'LATENCY_BREAKDOWN');
      assert.equal(breakdowns.length, 2);
      assert.match(
        breakdowns[1].message,
        /user_stop_to_gemini_turn_complete=400ms gemini_turn_complete_to_first_audio=600ms first_audio_to_twilio_send=0ms TOTAL_user_stop_to_twilio_send=1000ms/
      );

      for (const row of breakdowns) {
        assertAbcEqualsTotal(row.message);
      }
    } finally {
      logger.info = originalInfo;
      liveCallSession.setNowMsForTests(null);
    }
  });

  it('rejects stale stamp order with breakdown_incomplete instead of bad B', () => {
    const lines = [];
    const originalInfo = logger.info;
    logger.info = (tag, message) => {
      lines.push({ tag, message });
    };

    try {
      const session = withTurnSeq({
        callSid: 'CA_STALE',
        // userStop AFTER turnComplete (stale association from old bug)
        lastSpeechAudioAt: 20000,
        geminiUserTurnCompleteAt: 1400,
        turnGeminiFirstAudioAt: 20860,
        turnTwilioFirstSendAt: 20920,
        latencyBreakdownLogged: false,
        latencyBreakdownIncompleteLogged: false,
      });
      assert.equal(liveCallSession.maybeLogLatencyBreakdown(session), false);
      assert.equal(session.latencyBreakdownLogged, false);
      const incomplete = lines.find(
        (l) => l.tag === 'LATENCY' && /breakdown_incomplete/.test(l.message)
      );
      assert.ok(incomplete);
      assert.match(incomplete.message, /stamp_order/);
      assert.equal(
        lines.filter((l) => l.tag === 'LATENCY_BREAKDOWN').length,
        0
      );
    } finally {
      logger.info = originalInfo;
    }
  });

  it('speech after turnComplete freezes lastSpeech (no stamp_order)', () => {
    let t = 1000;
    liveCallSession.setNowMsForTests(() => t);

    const lines = [];
    const originalInfo = logger.info;
    logger.info = (tag, message) => {
      lines.push({ tag, message });
    };

    try {
      const session = {
        callSid: 'CA_FREEZE',
        streamSid: 'MZ_FREEZE',
        waiting: false,
        ending: false,
        playbackGeneration: 0,
        geminiChunkCount: 0,
        twilioFrameCount: 0,
        outboundRemainder: Buffer.alloc(0),
        suppressStaleOutput: false,
        aiSpeaking: false,
        turnFirstAudioLogged: false,
        t0: 0,
        lastSpeechAudioAt: null,
        geminiUserTurnCompleteAt: null,
        turnGeminiFirstAudioAt: null,
        turnTwilioFirstSendAt: null,
        latencyTurnSeq: 0,
        speechTurnSeq: null,
        turnCompleteTurnSeq: null,
        firstAudioTurnSeq: null,
        twilioSendTurnSeq: null,
        latencyBreakdownLogged: false,
        latencyBreakdownIncompleteLogged: false,
        lastUserTurnEndAt: null,
        firstGeminiAudioAt: null,
        firstTwilioOutAt: null,
        twilioWs: { readyState: 1, send() {} },
      };

      // User speech opens turn 1.
      t = 1000;
      liveCallSession.stampCallerSpeechForLatency(session, t);
      assert.equal(session.latencyTurnSeq, 1);
      assert.equal(session.lastSpeechAudioAt, 1000);

      t = 1300;
      session.geminiUserTurnCompleteAt = 1300;
      session.turnCompleteTurnSeq = 1;
      session.lastUserTurnEndAt = 1300;

      // Echo / continued speech-like frames after turnComplete must NOT move stop.
      t = 1450;
      liveCallSession.stampCallerSpeechForLatency(session, t);
      assert.equal(session.lastSpeechAudioAt, 1000);
      assert.equal(session.geminiUserTurnCompleteAt, 1300);

      // AI first audio → valid breakdown (A+B+C===TOTAL).
      t = 1600;
      liveCallSession.playGeminiPcmOnce(
        session,
        Buffer.alloc(480 * 2),
        session.playbackGeneration
      );
      assert.equal(session.latencyBreakdownLogged, true);
      assert.equal(session.lastSpeechAudioAt, 1000);

      const breakdown = lines.find((l) => l.tag === 'LATENCY_BREAKDOWN');
      assert.ok(breakdown);
      assertAbcEqualsTotal(breakdown.message);
      assert.equal(
        lines.filter((l) => /stamp_order/.test(l.message)).length,
        0
      );
    } finally {
      logger.info = originalInfo;
      liveCallSession.setNowMsForTests(null);
    }
  });

  it('speech after turnComplete does not restart window before AI audio', () => {
    const session = {
      callSid: 'CA_FREEZE2',
      lastSpeechAudioAt: 1000,
      geminiUserTurnCompleteAt: 1200,
      turnGeminiFirstAudioAt: null,
      turnTwilioFirstSendAt: null,
      latencyTurnSeq: 1,
      speechTurnSeq: 1,
      turnCompleteTurnSeq: 1,
      firstAudioTurnSeq: null,
      twilioSendTurnSeq: null,
      latencyBreakdownLogged: false,
      latencyBreakdownIncompleteLogged: false,
    };

    liveCallSession.stampCallerSpeechForLatency(session, 1500);
    assert.equal(session.latencyTurnSeq, 1);
    assert.equal(session.lastSpeechAudioAt, 1000);
    assert.equal(session.geminiUserTurnCompleteAt, 1200);
    assert.equal(session.speechTurnSeq, 1);
  });

  it('rejects turn_mismatch when stamp seqs disagree', () => {
    const lines = [];
    const originalInfo = logger.info;
    logger.info = (tag, message) => {
      lines.push({ tag, message });
    };

    try {
      const session = {
        callSid: 'CA_MISMATCH',
        lastSpeechAudioAt: 1000,
        geminiUserTurnCompleteAt: 1300,
        turnGeminiFirstAudioAt: 1600,
        turnTwilioFirstSendAt: 1650,
        latencyTurnSeq: 2,
        speechTurnSeq: 1, // leaked from prior turn
        turnCompleteTurnSeq: 2,
        firstAudioTurnSeq: 2,
        twilioSendTurnSeq: 2,
        latencyBreakdownLogged: false,
        latencyBreakdownIncompleteLogged: false,
      };
      assert.equal(liveCallSession.maybeLogLatencyBreakdown(session), false);
      const incomplete = lines.find((l) =>
        /breakdown_incomplete.*turn_mismatch/.test(l.message)
      );
      assert.ok(incomplete);
      assert.equal(
        lines.filter((l) => l.tag === 'LATENCY_BREAKDOWN').length,
        0
      );
    } finally {
      logger.info = originalInfo;
    }
  });

  it('clearLatencyLogOnStartup empties latency-latest.log', () => {
    fs.mkdirSync(require('path').dirname(liveCallSession.LATENCY_LOG_PATH), {
      recursive: true,
    });
    fs.writeFileSync(
      liveCallSession.LATENCY_LOG_PATH,
      'stale test line\n',
      'utf8'
    );
    liveCallSession.clearLatencyLogOnStartup();
    const contents = fs.readFileSync(liveCallSession.LATENCY_LOG_PATH, 'utf8');
    assert.equal(contents, '');
  });
});
