'use strict';

const mongoose = require('mongoose');

const CALL_STATUSES = [
  'incoming',
  'connected',
  'in-progress',
  'completed',
  'failed',
  'busy',
  'no-answer',
];

const callSchema = new mongoose.Schema(
  {
    callSid: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    conversationRelaySessionId: {
      type: String,
      default: null,
    },
    from: {
      type: String,
      default: null,
    },
    to: {
      type: String,
      default: null,
    },
    status: {
      type: String,
      enum: CALL_STATUSES,
      default: 'incoming',
      index: true,
    },
    direction: {
      type: String,
      default: 'inbound',
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    answeredAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    duration: {
      type: Number,
      default: null,
    },
    lastActivityAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

callSchema.index({ createdAt: -1 });

const Call = mongoose.model('Call', callSchema);

module.exports = {
  Call,
  CALL_STATUSES,
};
