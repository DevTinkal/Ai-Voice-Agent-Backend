'use strict';

const { Call } = require('../models/Call');
const { isDatabaseConnected } = require('../config/database');
const logger = require('../utils/logger');

/** Twilio CallSid: CA + 32 hex chars. Rejects probe/test IDs like CAprobe. */
const TWILIO_CALL_SID_RE = /^CA[0-9a-fA-F]{32}$/;

/** Active calls with no activity past this age are closed (orphaned probes / dropped media). */
const STALE_ACTIVE_MS = 10 * 60 * 1000;

function isValidTwilioCallSid(callSid) {
  return typeof callSid === 'string' && TWILIO_CALL_SID_RE.test(callSid);
}

async function closeStaleActiveCalls() {
  if (!isDatabaseConnected()) {
    return 0;
  }
  const cutoff = new Date(Date.now() - STALE_ACTIVE_MS);
  try {
    const result = await Call.updateMany(
      {
        status: { $in: ['incoming', 'connected', 'in-progress'] },
        $or: [
          { lastActivityAt: { $lt: cutoff } },
          {
            lastActivityAt: null,
            startedAt: { $lt: cutoff },
          },
        ],
      },
      {
        $set: {
          status: 'failed',
          endedAt: new Date(),
          lastActivityAt: new Date(),
        },
      }
    );
    const n = result.modifiedCount || 0;
    if (n > 0) {
      logger.info('CALL', `Closed ${n} stale active call(s)`);
    }
    return n;
  } catch (error) {
    logger.error('CALL', `Failed to close stale calls: ${error.message}`);
    return 0;
  }
}

async function createCall(data) {
  if (!isDatabaseConnected()) {
    logger.warn('CALL', 'Cannot create call — database unavailable');
    return null;
  }

  if (!isValidTwilioCallSid(data.callSid)) {
    logger.warn(
      'CALL',
      `Ignoring non-Twilio CallSid (probe/test?): ${data.callSid}`
    );
    return null;
  }

  try {
    const existing = await Call.findOne({ callSid: data.callSid });
    if (existing) {
      existing.from = data.from || existing.from;
      existing.to = data.to || existing.to;
      existing.status = data.status || existing.status;
      existing.direction = data.direction || existing.direction;
      if (data.agentId) {
        existing.agentId = data.agentId;
      }
      existing.lastActivityAt = new Date();
      await existing.save();
      logger.info('CALL', `Call updated ${data.callSid}`);
      return existing;
    }

    const call = await Call.create({
      callSid: data.callSid,
      from: data.from || null,
      to: data.to || null,
      status: data.status || 'incoming',
      direction: data.direction || 'inbound',
      agentId: data.agentId || null,
      startedAt: new Date(),
      lastActivityAt: new Date(),
    });

    logger.info('CALL', `Call created ${data.callSid}`);
    return call;
  } catch (error) {
    logger.error('CALL', `Failed to create call: ${error.message}`);
    return null;
  }
}

async function updateCallStatus(callSid, status, extra = {}) {
  if (!isDatabaseConnected()) {
    return null;
  }

  try {
    const update = {
      status,
      lastActivityAt: new Date(),
      ...extra,
    };

    const call = await Call.findOneAndUpdate({ callSid }, update, {
      new: true,
    });

    if (call) {
      logger.info('CALL', `Call ${callSid} status -> ${status}`);
    }
    return call;
  } catch (error) {
    logger.error('CALL', `Failed to update call status: ${error.message}`);
    return null;
  }
}

async function markAnswered(callSid, sessionId) {
  return updateCallStatus(callSid, 'connected', {
    answeredAt: new Date(),
    conversationRelaySessionId: sessionId || null,
  });
}

async function markInProgress(callSid) {
  return updateCallStatus(callSid, 'in-progress');
}

async function markCompleted(callSid) {
  if (!isDatabaseConnected()) {
    return null;
  }

  try {
    const call = await Call.findOne({ callSid });
    if (!call) {
      return null;
    }

    const endedAt = new Date();
    const start = call.answeredAt || call.startedAt || call.createdAt;
    const durationMs = start ? endedAt.getTime() - new Date(start).getTime() : 0;
    const duration = Math.max(0, Math.round(durationMs / 1000));

    call.status = 'completed';
    call.endedAt = endedAt;
    call.duration = duration;
    call.lastActivityAt = endedAt;
    await call.save();

    logger.info('CALL', `Call completed ${callSid} duration=${duration}s`);
    return call;
  } catch (error) {
    logger.error('CALL', `Failed to complete call: ${error.message}`);
    return null;
  }
}

async function markFailed(callSid) {
  return updateCallStatus(callSid, 'failed', {
    endedAt: new Date(),
  });
}

async function getCallBySid(callSid) {
  if (!isDatabaseConnected()) {
    return null;
  }

  try {
    return await Call.findOne({ callSid }).lean();
  } catch (error) {
    logger.error('CALL', `Failed to get call: ${error.message}`);
    return null;
  }
}

async function getRecentCalls(limit = 20, skip = 0) {
  if (!isDatabaseConnected()) {
    return { calls: [], hasMore: false };
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const safeSkip = Math.max(Number(skip) || 0, 0);

  try {
    await closeStaleActiveCalls();
    const filter = { callSid: { $regex: TWILIO_CALL_SID_RE } };
    // Fetch one extra to detect if more pages exist.
    const rows = await Call.find(filter)
      .sort({ createdAt: -1 })
      .skip(safeSkip)
      .limit(safeLimit + 1)
      .lean();
    const hasMore = rows.length > safeLimit;
    const calls = hasMore ? rows.slice(0, safeLimit) : rows;
    return { calls, hasMore };
  } catch (error) {
    logger.error('CALL', `Failed to list calls: ${error.message}`);
    return { calls: [], hasMore: false };
  }
}

async function getCallStatistics() {
  const empty = {
    totalCalls: 0,
    activeCalls: 0,
    completedCalls: 0,
    failedCalls: 0,
    callsToday: 0,
  };

  if (!isDatabaseConnected()) {
    return empty;
  }

  try {
    await closeStaleActiveCalls();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const realCallFilter = { callSid: { $regex: TWILIO_CALL_SID_RE } };

    const [totalCalls, activeCalls, completedCalls, failedCalls, callsToday] =
      await Promise.all([
        Call.countDocuments(realCallFilter),
        Call.countDocuments({
          ...realCallFilter,
          status: { $in: ['incoming', 'connected', 'in-progress'] },
        }),
        Call.countDocuments({ ...realCallFilter, status: 'completed' }),
        Call.countDocuments({
          ...realCallFilter,
          status: { $in: ['failed', 'busy', 'no-answer'] },
        }),
        Call.countDocuments({
          ...realCallFilter,
          createdAt: { $gte: startOfDay },
        }),
      ]);

    return {
      totalCalls,
      activeCalls,
      completedCalls,
      failedCalls,
      callsToday,
    };
  } catch (error) {
    logger.error('CALL', `Failed to get stats: ${error.message}`);
    return empty;
  }
}

async function touchActivity(callSid) {
  if (!isDatabaseConnected()) {
    return null;
  }

  try {
    return await Call.findOneAndUpdate(
      { callSid },
      { lastActivityAt: new Date() },
      { new: true }
    );
  } catch (error) {
    logger.error('CALL', `Failed to touch activity: ${error.message}`);
    return null;
  }
}

module.exports = {
  isValidTwilioCallSid,
  closeStaleActiveCalls,
  createCall,
  updateCallStatus,
  markAnswered,
  markInProgress,
  markCompleted,
  markFailed,
  getCallBySid,
  getRecentCalls,
  getCallStatistics,
  touchActivity,
};
