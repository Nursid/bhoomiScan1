/**
 * Mobile OTP login.
 *   sendOtp(mobile)            -> provider sends an SMS OTP
 *   verifyOtp(mobile, otp,...) -> provider verifies, user is created on first login,
 *                                 backend JWT is issued
 */

const { prisma } = require('../../database/prisma');
const logger = require('../../utils/logger');
const { maskMobile } = require('../../utils/sanitize');
const { normalizeMobile } = require('../../utils/mobile');
const { unauthorized, forbidden } = require('../../utils/errors');
const { getOtpProvider } = require('./otp.provider');
const tokens = require('./token.service');

const publicUser = (user) => ({
  id: user.id,
  mobile: user.mobile,
  name: user.name,
  email: user.email,
  role: user.role,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
});

const sendOtp = async (mobileE164) => {
  const mobile = normalizeMobile(mobileE164);
  const provider = getOtpProvider();
  const result = await provider.send(mobile);
  logger.info({ mobile: maskMobile(mobile.digits), provider: provider.name }, 'otp sent');
  return { mobile: mobile.e164, channel: result.channel, expiresInSeconds: result.expiresInSeconds };
};

const verifyOtp = async ({ mobile: mobileE164, otp, reqId, name }) => {
  const mobile = normalizeMobile(mobileE164);
  const provider = getOtpProvider();
  const { identifier } = await provider.verify(mobile, otp, { reqId });

  // Widget flow: the OTP proves knowledge of reqId's OTP; when MSG91 echoes the
  // number it was sent to, it must be the number the client claims.
  if (identifier) {
    const verified = normalizeMobile(identifier);
    if (!verified || verified.e164 !== mobile.e164) {
      logger.warn({ mobile: maskMobile(mobile.digits) }, 'otp identifier mismatch');
      throw unauthorized('Mobile number does not match the verified OTP session', 'OTP_MOBILE_MISMATCH');
    }
  }

  const now = new Date();
  const existing = await prisma.user.findUnique({ where: { mobile: mobile.e164 } });
  if (existing && existing.status !== 'ACTIVE') {
    throw forbidden('This account is blocked', 'ACCOUNT_BLOCKED');
  }
  // upsert: two concurrent first logins for the same number must not race into a duplicate.
  const user = await prisma.user.upsert({
    where: { mobile: mobile.e164 },
    create: { mobile: mobile.e164, name: name || null, lastLoginAt: now },
    update: { lastLoginAt: now, ...(name && !existing?.name ? { name } : {}) },
  });

  const { token, expiresAt } = tokens.generateToken(user);
  logger.info({ userId: user.id, isNewUser: !existing }, 'user logged in');
  return { token, tokenType: 'Bearer', expiresAt, isNewUser: !existing, user: publicUser(user) };
};

module.exports = { sendOtp, verifyOtp, publicUser };
