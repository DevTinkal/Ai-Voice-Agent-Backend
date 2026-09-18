'use strict';

const mongoose = require('mongoose');
const { env } = require('./env');
const logger = require('../utils/logger');

let isConnected = false;
let connectionAttempted = false;

async function connectDatabase() {
  connectionAttempted = true;
  logger.info('DATABASE', 'Connecting to MongoDB...');

  try {
    mongoose.set('strictQuery', true);
    await mongoose.connect(env.mongodbUri, {
      serverSelectionTimeoutMS: 5000,
    });
    isConnected = true;
    logger.info('DATABASE', 'MongoDB connected');
    return true;
  } catch (error) {
    isConnected = false;
    logger.error(
      'DATABASE',
      `MongoDB connection failed: ${error.message}`
    );
    return false;
  }
}

function getDatabaseStatus() {
  const readyState = mongoose.connection.readyState;
  // 1 = connected
  if (readyState === 1) {
    isConnected = true;
    return 'connected';
  }
  isConnected = false;
  if (!connectionAttempted) {
    return 'not_started';
  }
  return 'disconnected';
}

function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

async function disconnectDatabase() {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.connection.close();
    isConnected = false;
    logger.info('DATABASE', 'MongoDB connection closed');
  }
}

mongoose.connection.on('disconnected', () => {
  isConnected = false;
  logger.warn('DATABASE', 'MongoDB disconnected');
});

mongoose.connection.on('error', (error) => {
  isConnected = false;
  logger.error('DATABASE', `MongoDB error: ${error.message}`);
});

module.exports = {
  connectDatabase,
  disconnectDatabase,
  getDatabaseStatus,
  isDatabaseConnected,
};
