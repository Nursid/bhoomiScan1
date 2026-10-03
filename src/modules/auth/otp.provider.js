/**
 * OTP provider selection. Business logic (auth.service) only sees
 * `send(mobile)` / `verify(mobile, otp, { reqId })`.
 *
 *   msg91  MSG91 sends and verifies (OTP never stored or logged here)
 *   mock   development/test only, accepts OTP_MOCK_CODE; refused in production
 */

const { timingSafeEqual } = require('crypto');
const config = require('../../config');
const msg91 = require('../../integrations/msg91/msg91.client');
const { AppError, unauthorized } = require('../../utils/errors');

const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

const msg91Provider = {
  name: 'msg91',
  async send(mobile) {
    const { requestId } = await msg91.sendOtp(mobile.digits);
    return { channel: 'sms', providerRequestId: requestId, expiresInSeconds: config.msg91.otpExpiryMinutes * 60 };
  },
  async verify(mobile, otp, { reqId } = {}) {
    if (reqId) {
      const result = await msg91.verifyWidgetOtp(reqId, otp);
      return { identifier: result.identifier };
    }
    await msg91.verifyOtp(mobile.digits, otp);
    return { identifier: null };
  },
};

const mockProvider = {
  name: 'mock',
  async send() {
    return { channel: 'mock', providerRequestId: null, expiresInSeconds: 300 };
  },
  async verify(mobile, otp) {
    if (!safeEqual(otp, config.otp.mockCode)) {
      throw unauthorized('Invalid or expired OTP', 'INVALID_OTP');
    }
    return { identifier: null };
  },
};

const getOtpProvider = () => {
  if (config.otp.provider === 'mock') {
    if (config.isProduction) {
      throw new AppError(503, 'OTP_NOT_CONFIGURED', 'OTP login is not configured on the server');
    }
    return mockProvider;
  }
  return msg91Provider;
};

module.exports = { getOtpProvider };
