/**
 * Removes secrets from objects before they are persisted (ApiRequestLog,
 * provider audit data) or returned. Works on a deep copy.
 */

const { SENSITIVE_KEYS } = require('./logger');

const SENSITIVE = new Set(SENSITIVE_KEYS.map((key) => key.toLowerCase()));
const MAX_DEPTH = 12;

const sanitize = (value, depth = 0) => {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (depth > MAX_DEPTH) {
    return '[TRUNCATED]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, depth + 1));
  }
  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = SENSITIVE.has(key.toLowerCase()) ? '[REDACTED]' : sanitize(val, depth + 1);
  }
  return out;
};

/** Masks all but the last 4 digits of a phone number for logs. */
const maskMobile = (mobile) => {
  const digits = String(mobile || '').replace(/\D/g, '');
  return digits ? `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}` : '';
};

module.exports = { sanitize, maskMobile };
