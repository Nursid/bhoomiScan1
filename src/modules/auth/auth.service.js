/**
 * Mobile OTP login via the MSG91 OTP Widget (same API as the reference backend's
 * server/mobileVerify.js).
 *
 *   POST /api/auth/mobile-verify   { mobile, otp, reqId }
 *   GET  /api/auth/me              Bearer token -> identity
 *
 * The UI calls the MSG91 widget's sendOtp() and receives a reqId. This backend
 * never generates, sends, stores or compares an OTP. It only:
 *   1. validates the request,
 *   2. asks MSG91 to verify `otp` for `reqId`,
 *   3. on success finds/creates the user and issues the login JWT.
 *
 * Difference from the reference: this service has a users table, so `user.id`
 * is the database user id (uuid) instead of the E.164 mobile number.
 */

const { prisma } = require('../../database/prisma');
const config = require('../../config');
const logger = require('../../utils/logger');
const { maskMobile } = require('../../utils/sanitize');
const { normalizeMobile } = require('../../utils/mobile');
const { AppError } = require('../../utils/errors');
const msg91 = require('../../integrations/msg91/msg91.client');
const tokens = require('./token.service');

const LOGIN_METHOD = 'mobile_otp';

const authError = (statusCode, code, message) => new AppError(statusCode, code, message);

/* ------------------------------ Request checks ---------------------------- */

const readRequest = (body) => {
  const mobile = normalizeMobile(body?.mobile);
  if (!mobile) {
    throw authError(400, 'INVALID_MOBILE', 'Invalid mobile number');
  }

  const otp = body?.otp === undefined || body?.otp === null ? '' : String(body.otp).trim();
  if (!/^\d{4,8}$/.test(otp)) {
    throw authError(400, 'INVALID_OTP_FORMAT', 'Invalid OTP');
  }

  const reqId = typeof body?.reqId === 'string' ? body.reqId.trim() : '';
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(reqId)) {
    throw authError(400, 'REQ_ID_REQUIRED', 'reqId is required');
  }

  return { mobile, otp, reqId };
};

/* --------------------------- Application login step ----------------------- */

const issueApplicationLogin = async (mobile) => {
  const now = new Date();
  const existing = await prisma.user.findUnique({ where: { mobile: mobile.e164 } });
  if (existing && existing.status !== 'ACTIVE') {
    throw authError(403, 'ACCOUNT_BLOCKED', 'This account is blocked');
  }
  // upsert: two concurrent first logins for the same number must not race into a duplicate.
  const user = await prisma.user.upsert({
    where: { mobile: mobile.e164 },
    create: { mobile: mobile.e164, lastLoginAt: now },
    update: { lastLoginAt: now },
  });

  const { token } = tokens.generateToken({ ...user, loginMethod: LOGIN_METHOD });
  logger.info({ userId: user.id, isNewUser: !existing }, 'user logged in');
  return {
    success: true,
    token,
    user: {
      id: user.id,
      mobile: user.mobile,
      loginMethod: LOGIN_METHOD,
      lastLoginAt: now.toISOString(),
    },
  };
};

/* --------------------------------- Handlers ------------------------------- */

const mobileVerify = async (body) => {
  if (!msg91.isConfigured()) {
    throw authError(503, 'OTP_NOT_CONFIGURED', 'Mobile OTP login is not configured on the server (MSG91).');
  }
  if (!config.jwt.isConfigured) {
    throw authError(503, 'AUTH_NOT_CONFIGURED', 'Login tokens are not configured on the server (JWT_SECRET).');
  }

  const { mobile, otp, reqId } = readRequest(body);

  let result;
  try {
    result = await msg91.verifyWidgetOtp({ reqId, otp });
  } catch (error) {
    if (error instanceof msg91.Msg91Error) {
      const code = { 401: 'INVALID_OTP', 503: 'OTP_NOT_CONFIGURED' }[error.statusCode] || 'OTP_PROVIDER_ERROR';
      throw authError(error.statusCode, code, error.message);
    }
    throw error;
  }

  if (result.identifier) {
    const verifiedMobile = normalizeMobile(result.identifier);
    if (!verifiedMobile || verifiedMobile.e164 !== mobile.e164) {
      logger.warn({ mobile: maskMobile(mobile.digits) }, '[MOBILE VERIFY] Client mobile does not match the number MSG91 verified');
      throw authError(401, 'OTP_MOBILE_MISMATCH', 'Mobile number does not match the verified OTP session');
    }
  }

  logger.info({ mobile: maskMobile(mobile.digits), reqId }, '[MOBILE VERIFY] OTP verified by MSG91');
  return issueApplicationLogin(mobile);
};

/** Identity behind a login token (req.user / req.auth set by authenticate). */
const me = async (user, claims) => {
  const record = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
  return {
    success: true,
    user: {
      id: record.id,
      mobile: record.mobile || null,
      email: record.email || null,
      role: record.role.toLowerCase(),
      loginMethod: claims.loginMethod || null,
    },
    expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
  };
};

const publicUser = (user) => ({
  id: user.id,
  mobile: user.mobile,
  name: user.name,
  email: user.email,
  role: user.role,
  createdAt: user.createdAt,
  lastLoginAt: user.lastLoginAt,
});

module.exports = { mobileVerify, me, publicUser, issueApplicationLogin, __testing: { readRequest } };
