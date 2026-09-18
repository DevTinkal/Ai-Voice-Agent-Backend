'use strict';

/**
 * Time-of-day helpers for spoken phone greetings.
 * Default timezone is Asia/Kolkata (demo callers are typically India).
 */

const DEFAULT_TIMEZONE = 'Asia/Kolkata';

/**
 * @param {Date} [now]
 * @param {string} [timeZone]
 * @returns {{
 *   period: 'morning'|'afternoon'|'evening'|'night',
 *   greeting: string,
 *   helpWhen: 'today'|'this evening'|'tonight',
 *   hour: number
 * }}
 */
function getTimeOfDay(now = new Date(), timeZone = DEFAULT_TIMEZONE) {
  let hour = now.getHours();

  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(now);
    const hourPart = parts.find((p) => p.type === 'hour');
    if (hourPart) {
      hour = Number(hourPart.value) % 24;
    }
  } catch {
    // Fall back to server local hour.
  }

  if (hour >= 5 && hour < 12) {
    return {
      period: 'morning',
      greeting: 'Good morning',
      helpWhen: 'today',
      hour,
    };
  }
  if (hour >= 12 && hour < 16) {
    return {
      period: 'afternoon',
      greeting: 'Good afternoon',
      helpWhen: 'today',
      hour,
    };
  }
  if (hour >= 16 && hour < 21) {
    return {
      period: 'evening',
      greeting: 'Good evening',
      helpWhen: 'this evening',
      hour,
    };
  }
  return {
    period: 'night',
    greeting: 'Hello',
    helpWhen: 'tonight',
    hour,
  };
}

function buildWelcomeGreeting(timeZone = DEFAULT_TIMEZONE) {
  const { greeting } = getTimeOfDay(new Date(), timeZone);
  return `${greeting}! Welcome to the AI voice assistant. How can I help you today?`;
}

module.exports = {
  DEFAULT_TIMEZONE,
  getTimeOfDay,
  buildWelcomeGreeting,
};
