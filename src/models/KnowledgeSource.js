'use strict';

const mongoose = require('mongoose');

/**
 * Singleton meta for the filesystem knowledge source (company.txt).
 * Tracks content hash so startup skips re-index when unchanged.
 */
const knowledgeSourceSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      unique: true,
      default: 'default',
    },
    filePath: {
      type: String,
      default: '',
    },
    contentHash: {
      type: String,
      default: null,
    },
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'KnowledgeDocument',
      default: null,
    },
    status: {
      type: String,
      enum: ['missing', 'pending', 'indexing', 'ready', 'failed'],
      default: 'missing',
    },
    charCount: {
      type: Number,
      default: 0,
    },
    chunkCount: {
      type: Number,
      default: 0,
    },
    error: {
      type: String,
      default: null,
    },
    embeddingModel: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const KnowledgeSource = mongoose.model('KnowledgeSource', knowledgeSourceSchema);

module.exports = {
  KnowledgeSource,
};
