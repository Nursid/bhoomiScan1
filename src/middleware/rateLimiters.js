/**
 * Rate limits. OTP limits are keyed by mobile number AND IP so one attacker can't
 * spray many numbers and one number can't be flooded from many IPs.
 * (In-memory store; for several API instances put a shared store behind it,
 * e.g. rate-limit-redis, or enforce at the gateway.)
 */

const { rateLimit } = require('express-rate-limit');
const config = require('../config');
const { AppError } = require('../utils/errors');
const { normalizeMobile } = require('../utils/mobile');

const handler = (req, res, next, options) => {
  next(
    new AppError(429, 'RATE_LIMITED', 'Too many requests, please try again later', {
      retryAfter: Math.ceil(options.windowMs / 1000),
    }),
  );
};

const base = (overrides) =>
  rateLimit({
    windowMs: config.rateLimit.windowMs,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler,
    skip: () => config.isTest && process.env.RATE_LIMIT_IN_TESTS !== 'true',
    ...overrides,
  });

const ipKey = (req) => req.ip || 'unknown';

const mobileKey = (prefix) => (req) => {
  const mobile = normalizeMobile(req.body?.mobile);
  return `${prefix}:${mobile ? mobile.e164 : 'invalid'}`;
};

// The Razorpay webhook is exempt: deliveries come in bursts from a few Razorpay IPs
// and every request must carry a valid signature anyway.
const globalLimiter = base({
  limit: config.rateLimit.globalMax,
  keyGenerator: ipKey,
  skip: (req) => (config.isTest && process.env.RATE_LIMIT_IN_TESTS !== 'true') || req.path === '/payments/webhook',
});

const otpVerifyLimiters = [
  base({ limit: config.rateLimit.otpVerifyMax, keyGenerator: mobileKey('otp-verify') }),
  base({ limit: config.rateLimit.otpVerifyMax * 4, keyGenerator: (req) => `otp-verify-ip:${ipKey(req)}` }),
];

// Keyed by user (runs after authenticate).
const landVerifyLimiter = base({
  limit: config.rateLimit.landVerifyMax,
  keyGenerator: (req) => `land-verify:${req.user?.id || ipKey(req)}`,
});

module.exports = { globalLimiter, otpVerifyLimiters, landVerifyLimiter };
