/**
 * Mobile OTP login via the MSG91 OTP Widget (same API as the reference backend's
 * server/mobileVerify.js), and Google login via Firebase Auth.
 *
 *   POST /api/auth/mobile-verify   { mobile, otp, reqId }
 *   POST /api/auth/google          { idToken }   Firebase ID token from signInWithPopup()
 *   POST /api/auth/google/link     { idToken }   Bearer token; links Google to the logged-in account
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
 *
 * Google login issues the same login JWT. The Firebase ID token is verified by
 * Firebase Admin; the user is found by the verified Firebase UID only. An
 * account is never merged by email: if another account already uses the Google
 * email, the user must log in with OTP and link Google (POST /google/link).
 */

const { prisma } = require('../../database/prisma');
const config = require('../../config');
const logger = require('../../utils/logger');
const { maskMobile } = require('../../utils/sanitize');
const { normalizeMobile } = require('../../utils/mobile');
const { AppError } = require('../../utils/errors');
const msg91 = require('../../integrations/msg91/msg91.client');
const firebase = require('../../integrations/firebase/firebase-admin.client');
const tokens = require('./token.service');

const LOGIN_METHOD = 'mobile_otp';
const GOOGLE_LOGIN_METHOD = 'google';
const GOOGLE_PROVIDER = 'google.com';

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

/* ------------------------------- Google login ----------------------------- */

const readIdToken = (body) => {
  const idToken = typeof body?.idToken === 'string' ? body.idToken.trim() : '';
  // A Firebase ID token is a compact JWS (three base64url parts), ~1 KB.
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(idToken) || idToken.length > 8192) {
    throw authError(400, 'ID_TOKEN_REQUIRED', 'idToken is required');
  }
  return idToken;
};

/** Verifies the Firebase ID token and requires a verified Google identity. */
const verifyGoogleIdentity = async (idToken) => {
  let identity;
  try {
    identity = await firebase.verifyIdToken(idToken);
  } catch (error) {
    if (error instanceof firebase.FirebaseAuthError) {
      throw authError(error.statusCode, error.code, error.message);
    }
    throw error;
  }
  if (identity.provider !== GOOGLE_PROVIDER) {
    throw authError(401, 'UNSUPPORTED_SIGN_IN_PROVIDER', 'Please sign in with Google');
  }
  if (!identity.email || !identity.emailVerified) {
    throw authError(403, 'EMAIL_NOT_VERIFIED', 'Your Google account email is not verified');
  }
  return identity;
};

const ensureGoogleConfigured = () => {
  if (!firebase.isConfigured()) {
    throw authError(503, 'GOOGLE_LOGIN_NOT_CONFIGURED', 'Google login is not configured on the server (FIREBASE_PROJECT_ID).');
  }
  if (!config.jwt.isConfigured) {
    throw authError(503, 'AUTH_NOT_CONFIGURED', 'Login tokens are not configured on the server (JWT_SECRET).');
  }
};

const googleUserResponse = (user) => ({
  id: user.id,
  mobile: user.mobile || null,
  email: user.email || null,
  name: user.name || null,
  loginMethod: GOOGLE_LOGIN_METHOD,
  lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
});

const googleLogin = async (body) => {
  ensureGoogleConfigured();
  const identity = await verifyGoogleIdentity(readIdToken(body));
  const now = new Date();

  const existing = await prisma.user.findUnique({ where: { firebaseUid: identity.uid } });
  if (existing && existing.status !== 'ACTIVE') {
    throw authError(403, 'ACCOUNT_BLOCKED', 'This account is blocked');
  }

  if (!existing) {
    // Same email on another account (e.g. an OTP user who added it): do not merge on email alone.
    const emailOwner = await prisma.user.findFirst({
      where: {
        email: { equals: identity.email, mode: 'insensitive' },
        OR: [{ firebaseUid: null }, { firebaseUid: { not: identity.uid } }],
      },
      select: { id: true },
    });
    if (emailOwner) {
      logger.warn({ userId: emailOwner.id }, '[GOOGLE LOGIN] Email belongs to an account not linked to this Google identity');
      throw authError(
        409,
        'ACCOUNT_LINK_REQUIRED',
        'An account with this email already exists. Log in with your mobile number and link Google from your account.',
      );
    }
  }

  // upsert on the unique Firebase UID: concurrent first logins cannot create two users.
  // Role and status always come from our defaults / existing record, never from Google.
  const user = await prisma.user.upsert({
    where: { firebaseUid: identity.uid },
    create: { firebaseUid: identity.uid, email: identity.email, name: identity.name, lastLoginAt: now },
    update: { lastLoginAt: now },
  });
  if (user.status !== 'ACTIVE') {
    throw authError(403, 'ACCOUNT_BLOCKED', 'This account is blocked');
  }

  const { token } = tokens.generateToken({ ...user, loginMethod: GOOGLE_LOGIN_METHOD });
  logger.info({ userId: user.id, isNewUser: !existing }, 'user logged in with Google');
  return { success: true, token, user: googleUserResponse(user) };
};

/** Links a verified Google identity to the logged-in account (proof of both identities). */
const linkGoogle = async (currentUser, body) => {
  ensureGoogleConfigured();
  const identity = await verifyGoogleIdentity(readIdToken(body));

  const owner = await prisma.user.findUnique({ where: { firebaseUid: identity.uid }, select: { id: true } });
  if (owner && owner.id !== currentUser.id) {
    throw authError(409, 'GOOGLE_ACCOUNT_IN_USE', 'This Google account is already linked to another account');
  }
  const record = await prisma.user.findUniqueOrThrow({ where: { id: currentUser.id } });
  if (record.firebaseUid && record.firebaseUid !== identity.uid) {
    throw authError(409, 'GOOGLE_ALREADY_LINKED', 'A different Google account is already linked to this account');
  }

  const user = owner
    ? record
    : await prisma.user.update({
        where: { id: record.id },
        data: { firebaseUid: identity.uid, email: record.email || identity.email, name: record.name || identity.name },
      });
  logger.info({ userId: user.id }, 'Google account linked');
  return {
    success: true,
    user: { id: user.id, mobile: user.mobile || null, email: user.email || null, name: user.name || null, googleLinked: true },
  };
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

module.exports = { mobileVerify, googleLogin, linkGoogle, me, publicUser, issueApplicationLogin, __testing: { readRequest, readIdToken } };
