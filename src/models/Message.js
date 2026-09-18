'use strict';

const mongoose = require('mongoose');

const MESSAGE_ROLES = ['user', 'assistant', 'system'];

const messageSchema = new mongoose.Schema(
  {
    callSid: {
      type: String,
      required: true,
      index: true,
    },
    role: {
      type: String,
      enum: MESSAGE_ROLES,
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: false,
  }
);

messageSchema.index({ callSid: 1, timestamp: 1 });

const Message = mongoose.model('Message', messageSchema);

module.exports = {
  Message,
  MESSAGE_ROLES,
};
