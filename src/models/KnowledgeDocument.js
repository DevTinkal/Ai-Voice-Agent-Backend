'use strict';

const mongoose = require('mongoose');

const KNOWLEDGE_SOURCES = ['paste', 'upload', 'file', 'agent'];
const KNOWLEDGE_STATUSES = ['pending', 'indexing', 'ready', 'failed'];

const knowledgeDocumentSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },
    source: {
      type: String,
      enum: KNOWLEDGE_SOURCES,
      default: 'paste',
    },
    rawText: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: KNOWLEDGE_STATUSES,
      default: 'pending',
      index: true,
    },
    charCount: {
      type: Number,
      default: 0,
    },
    /** SHA-256 of source file when source === 'file'. */
    contentHash: {
      type: String,
      default: null,
    },
    error: {
      type: String,
      default: null,
    },
    /** Embedding model used when this document was last indexed. */
    embeddingModel: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const KnowledgeDocument = mongoose.model(
  'KnowledgeDocument',
  knowledgeDocumentSchema
);

module.exports = {
  KnowledgeDocument,
  KNOWLEDGE_SOURCES,
  KNOWLEDGE_STATUSES,
};
