'use strict';

function formatMessage(tag, message) {
  const prefix = tag ? `[${tag}]` : '[APP]';
  return `${prefix} ${message}`;
}

const logger = {
  info(tag, message, meta) {
    if (meta !== undefined) {
      console.log(formatMessage(tag, message), meta);
    } else {
      console.log(formatMessage(tag, message));
    }
  },

  warn(tag, message, meta) {
    if (meta !== undefined) {
      console.warn(formatMessage(tag, message), meta);
    } else {
      console.warn(formatMessage(tag, message));
    }
  },

  error(tag, message, meta) {
    if (meta !== undefined) {
      console.error(formatMessage(tag, message), meta);
    } else {
      console.error(formatMessage(tag, message));
    }
  },
};

module.exports = logger;
