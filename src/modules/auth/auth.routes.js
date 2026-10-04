/**
 * Mounted at /api/auth (same paths as the reference backend):
 *   POST /api/auth/mobile-verify   { mobile, otp, reqId }
 *   GET  /api/auth/me              Authorization: Bearer <token>
 */

const { Router } = require('express');
const { authenticate } = require('../../middleware/authenticate');
const { otpVerifyLimiters } = require('../../middleware/rateLimiters');
const controller = require('./auth.controller');

const router = Router();

router.post('/mobile-verify', ...otpVerifyLimiters, controller.mobileVerify);
router.get('/me', authenticate, controller.me);

module.exports = router;
