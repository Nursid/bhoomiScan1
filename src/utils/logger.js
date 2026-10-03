/**
 * Structured logger (pino). Authorization headers, OTPs, tokens, signatures and
 * secrets are redacted wherever they appear in a logged object.
 */

const pino = require('pino');
const config = require('../config');

const SENSITIVE_KEYS = [
  'authorization',
  'cookie',
  'otp',
  'token',
  'accessToken',
  'access_token',
  'tokenAuth',
  'authkey',
  'authKey',
  'password',
  'secret',
  'keySecret',
  'apiKey',
  'privateKey',
  'razorpay_signature',
  'signature',
  'x-razorpay-signature',
  'x-api-key',
];

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const accessor = (key) => (IDENTIFIER.test(key) ? `.${key}` : `["${key}"]`);

// Redact sensitive keys at the top level and up to two levels deep.
const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS.flatMap((key) => {
    const part = accessor(key);
    return [part.replace(/^\./, ''), `*${part}`, `*.*${part}`];
  }),
];

const logger = pino({
  level: config.isTest ? process.env.LOG_LEVEL || 'silent' : config.logLevel,
  redact: { paths: redactPaths, censor: '[REDACTED]' },
  base: { service: 'bhoomiscan-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
module.exports.SENSITIVE_KEYS = SENSITIVE_KEYS;
