'use strict';

const WebSocket = require('ws');
const { env } = require('../config/env');
const logger = require('../utils/logger');

/**
 * Deepgram Flux streaming STT.
 * Events: partial, final, endOfTurn, error, open, close.
 */
function createFluxClient(options = {}) {
  const apiKey = options.apiKey || env.deepgramApiKey;
  const model = options.model || env.deepgramFluxModel || 'flux-general-en';
  const WebSocketImpl = options.WebSocketImpl || WebSocket;
  const listeners = {
    partial: [],
    final: [],
    endOfTurn: [],
    error: [],
    open: [],
    close: [],
  };

  function emit(name, payload) {
    for (const fn of listeners[name] || []) {
      try {
        fn(payload);
      } catch (error) {
        logger.warn('FLUX', `listener ${name}: ${error.message}`);
      }
    }
  }

  const params = new URLSearchParams({
    model,
    encoding: 'linear16',
    sample_rate: '16000',
  });
  const url =
    options.url || `wss://api.deepgram.com/v2/listen?${params.toString()}`;

  let socket = null;
  if (!apiKey && !options.socket) {
    logger.warn('FLUX', 'DEEPGRAM_API_KEY missing — classic STT will not connect');
  } else {
    socket =
      options.socket ||
      new WebSocketImpl(url, {
        headers: { Authorization: `Token ${apiKey}` },
      });
    socket.on('open', () => emit('open', {}));
    socket.on('close', () => emit('close', {}));
    socket.on('error', (error) => emit('error', error));
    socket.on('message', (data) => {
      handleFluxMessage(data, emit);
    });
  }

  return {
    socket,
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
    },
    sendPcm(pcm16k) {
      if (!socket || socket.readyState !== 1 || !pcm16k) return;
      socket.send(pcm16k);
    },
    close() {
      try {
        if (socket && socket.readyState === 1) {
          socket.send(JSON.stringify({ type: 'CloseStream' }));
          socket.close();
        }
      } catch {
        // ignore
      }
    },
  };
}

/**
 * @param {Buffer|string} data
 * @param {(name: string, payload: object) => void} emit
 */
function handleFluxMessage(data, emit) {
  let msg;
  try {
    msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
  } catch {
    return;
  }
  const transcript = String(
    (msg.transcript != null && msg.transcript) ||
      (msg.channel &&
        msg.channel.alternatives &&
        msg.channel.alternatives[0] &&
        msg.channel.alternatives[0].transcript) ||
      ''
  ).trim();
  const event = String(msg.event || msg.type || '').toLowerCase();
  if (event === 'update' || event === 'eagerendofturn') {
    if (transcript) emit('partial', { text: transcript, raw: msg });
  }
  if (event === 'endofturn' || msg.speech_final === true || msg.is_final === true) {
    if (transcript) {
      emit('final', { text: transcript, raw: msg });
      if (event === 'endofturn' || msg.speech_final === true) {
        emit('endOfTurn', { text: transcript, raw: msg });
      }
    }
  }
}

module.exports = {
  createFluxClient,
  handleFluxMessage,
};
