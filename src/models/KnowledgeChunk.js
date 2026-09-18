'use strict';

const mongoose = require('mongoose');

const knowledgeChunkSchema = new mongoose.Schema(
  {
    documentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'KnowledgeDocument',
      required: true,
      index: true,
    },
    index: {
      type: Number,
      required: true,
    },
    text: {
      type: String,
      required: true,
    },
    embedding: {
      type: [Number],
      required: true,
    },
    charCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

knowledgeChunkSchema.index({ documentId: 1, index: 1 });

const KnowledgeChunk = mongoose.model('KnowledgeChunk', knowledgeChunkSchema);

module.exports = {
  KnowledgeChunk,
};
