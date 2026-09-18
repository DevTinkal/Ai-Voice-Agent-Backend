'use strict';

const twilio = require('twilio');
const { env } = require('../config/env');
const logger = require('../utils/logger');

/** @type {ReturnType<typeof twilio> | null} */
let client = null;

function getTwilioClient() {
  if (!env.twilioAccountSid || !env.twilioAuthToken) {
    throw Object.assign(new Error('Twilio credentials are not configured'), {
      code: 'TWILIO_NOT_CONFIGURED',
      status: 503,
    });
  }
  if (!env.twilioPhoneNumber) {
    throw Object.assign(new Error('TWILIO_PHONE_NUMBER is not configured'), {
      code: 'TWILIO_FROM_MISSING',
      status: 503,
    });
  }
  if (!client) {
    client = twilio(env.twilioAccountSid, env.twilioAuthToken);
  }
  return client;
}

/**
 * Normalize phone to E.164.
 * Accepts full E.164, or Indian local forms with default country +91:
 *   9876543210 → +919876543210
 *   09876543210 → +919876543210
 *   919876543210 → +919876543210
 * @param {unknown} value
 * @returns {string}
 */
function normalizeAndValidateE164(value) {
  const stripped = String(value || '')
    .trim()
    .replace(/[\s().-]/g, '');

  if (!stripped) {
    throw Object.assign(
      new Error('Enter a phone number, e.g. 9876543210 or +919876543210'),
      { code: 'INVALID_PHONE', status: 400 }
    );
  }

  let candidate = stripped;
  if (candidate.startsWith('+')) {
    // already international
  } else if (/^0[6-9]\d{9}$/.test(candidate)) {
    // India trunk prefix
    candidate = `+91${candidate.slice(1)}`;
  } else if (/^[6-9]\d{9}$/.test(candidate)) {
    // India 10-digit mobile
    candidate = `+91${candidate}`;
  } else if (/^91[6-9]\d{9}$/.test(candidate)) {
    candidate = `+${candidate}`;
  } else if (/^\d{8,15}$/.test(candidate)) {
    throw Object.assign(
      new Error(
        'Include country code (default India +91). Example: 9876543210 or +14155552671'
      ),
      { code: 'INVALID_PHONE', status: 400 }
    );
  } else {
    throw Object.assign(
      new Error(
        'Invalid phone number. Use digits only, e.g. 9876543210 or +919876543210'
      ),
      { code: 'INVALID_PHONE', status: 400 }
    );
  }

  if (!/^\+[1-9]\d{7,14}$/.test(candidate)) {
    throw Object.assign(
      new Error(
        'phoneNumber must be E.164 format, e.g. +919876543210'
      ),
      { code: 'INVALID_PHONE', status: 400 }
    );
  }
  return candidate;
}

/**
 * Start an outbound Twilio Voice call. Secrets never returned.
 * @param {{ to: string, twimlUrl: string, statusCallbackUrl?: string }} opts
 */
async function createOutboundCall(opts) {
  const to = normalizeAndValidateE164(opts.to);
  const twimlUrl = String(opts.twimlUrl || '').trim();
  if (!twimlUrl) {
    throw Object.assign(new Error('Outbound TwiML URL is not configured'), {
      code: 'TWIML_URL_MISSING',
      status: 503,
    });
  }

  const from = env.twilioPhoneNumber;
  const twilioClient = getTwilioClient();

  try {
    const call = await twilioClient.calls.create({
      to,
      from,
      url: twimlUrl,
      method: 'POST',
      ...(opts.statusCallbackUrl
        ? {
            statusCallback: opts.statusCallbackUrl,
            statusCallbackMethod: 'POST',
            statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          }
        : {}),
    });

    logger.info(
      'TWILIO',
      `Outbound call created sid=${call.sid} to=${to} from=${from}`
    );

    return {
      callSid: call.sid,
      status: call.status || 'queued',
      to,
      from,
      direction: 'outbound',
    };
  } catch (error) {
    const status = Number(error.status) || 502;
    const message =
      error.message || 'Twilio failed to create the outbound call';
    logger.error('TWILIO', `Outbound create failed: ${message}`);
    throw Object.assign(new Error(message), {
      code: error.code || 'TWILIO_CREATE_FAILED',
      status: status >= 400 && status < 600 ? status : 502,
    });
  }
}

/**
 * Hang up an in-progress Twilio call.
 * @param {string} callSid
 */
async function hangupCall(callSid) {
  const sid = String(callSid || '').trim();
  if (!sid) {
    throw Object.assign(new Error('callSid is required'), {
      code: 'MISSING_CALL_SID',
      status: 400,
    });
  }
  const twilioClient = getTwilioClient();
  try {
    const call = await twilioClient.calls(sid).update({ status: 'completed' });
    logger.info('TWILIO', `Outbound call hung up sid=${sid}`);
    return {
      callSid: call.sid,
      status: call.status || 'completed',
    };
  } catch (error) {
    const status = Number(error.status) || 502;
    throw Object.assign(new Error(error.message || 'Hangup failed'), {
      code: error.code || 'TWILIO_HANGUP_FAILED',
      status: status >= 400 && status < 600 ? status : 502,
    });
  }
}

/** Test helper — clear cached client. */
function resetTwilioClientForTests() {
  client = null;
}

module.exports = {
  normalizeAndValidateE164,
  createOutboundCall,
  hangupCall,
  getTwilioClient,
  resetTwilioClientForTests,
};
