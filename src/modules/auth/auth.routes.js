const { Router } = require('express');
const validate = require('../../middleware/validate');
const { otpSendLimiters, otpVerifyLimiters } = require('../../middleware/rateLimiters');
const { sendOtpSchema, verifyOtpSchema } = require('./auth.validation');
const controller = require('./auth.controller');

const router = Router();

router.post('/send-otp', ...otpSendLimiters, validate({ body: sendOtpSchema }), controller.sendOtp);
router.post('/verify-otp', ...otpVerifyLimiters, validate({ body: verifyOtpSchema }), controller.verifyOtp);

module.exports = router;
