'use strict';

const mongoose = require('mongoose');

const AGENT_STATUSES = ['active', 'disabled'];

const promptSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

const agentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    prompts: {
      type: [promptSchema],
      default: [],
    },
    /**
     * Spoken languages the agent may reply in (e.g. English, Hindi).
     * Caller language is detected at runtime; if not in this list, English is used.
     */
    languages: {
      type: [String],
      default: ['English'],
    },
    status: {
      type: String,
      enum: AGENT_STATUSES,
      default: 'active',
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

const Agent = mongoose.model('Agent', agentSchema);

module.exports = {
  Agent,
  AGENT_STATUSES,
};
