'use strict';

const { Call } = require('../models/Call');
const { isDatabaseConnected } = require('../config/database');
const logger = require('../utils/logger');

async function createCall(data) {
  if (!isDatabaseConnected()) {
    logger.warn('CALL', 'Cannot create call — database unavailable');
    return null;
  }

  try {
    const existing = await Call.findOne({ callSid: data.callSid });
    if (existing) {
      existing.from = data.from || existing.from;
      existing.to = data.to || existing.to;
      existing.status = data.status || existing.status;
      existing.direction = data.direction || existing.direction;
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

async function getRecentCalls(limit = 20) {
  if (!isDatabaseConnected()) {
    return [];
  }

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);

  try {
    return await Call.find({})
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .lean();
  } catch (error) {
    logger.error('CALL', `Failed to list calls: ${error.message}`);
    return [];
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
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [totalCalls, activeCalls, completedCalls, failedCalls, callsToday] =
      await Promise.all([
        Call.countDocuments({}),
        Call.countDocuments({
          status: { $in: ['incoming', 'connected', 'in-progress'] },
        }),
        Call.countDocuments({ status: 'completed' }),
        Call.countDocuments({
          status: { $in: ['failed', 'busy', 'no-answer'] },
        }),
        Call.countDocuments({ createdAt: { $gte: startOfDay } }),
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
