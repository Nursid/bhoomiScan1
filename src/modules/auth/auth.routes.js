/**
 * Mounted at /api/auth (same paths as the reference backend):
 *   POST /api/auth/mobile-verify   { mobile, otp, reqId }
 *   POST /api/auth/google          { idToken }   Firebase ID token (Google sign-in)
 *   POST /api/auth/google/link     { idToken }   Authorization: Bearer <token>
 *   GET  /api/auth/me              Authorization: Bearer <token>
 */

const { Router } = require('express');
const { authenticate } = require('../../middleware/authenticate');
const { otpVerifyLimiters, googleLoginLimiter } = require('../../middleware/rateLimiters');
const controller = require('./auth.controller');

const router = Router();

router.post('/mobile-verify', ...otpVerifyLimiters, controller.mobileVerify);
router.post('/google', googleLoginLimiter, controller.googleLogin);
router.post('/google/link', googleLoginLimiter, authenticate, controller.linkGoogle);
router.get('/me', authenticate, controller.me);

module.exports = router;
