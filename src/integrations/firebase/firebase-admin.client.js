/**
 * Firebase Admin client for Google login (POST /api/auth/google).
 *
 * The browser signs in with Google through the Firebase JS SDK and sends the
 * Firebase ID token here. This module only verifies that token with Firebase
 * Admin (signature, issuer, audience = FIREBASE_PROJECT_ID, expiry and, when
 * credentials are available, revocation / disabled user) and returns the
 * verified identity. Nothing the client says about itself is trusted.
 *
 * Firebase Admin is initialised once, lazily, as a named app so it never clashes
 * with another initializeApp() in the same process. Credentials:
 *   FIREBASE_SERVICE_ACCOUNT_JSON  -> cert(serviceAccount)
 *   GOOGLE_APPLICATION_CREDENTIALS -> applicationDefault()
 *   neither                        -> project id only (signature/expiry checks work;
 *                                     revocation checks need credentials)
 *
 * ID tokens and credentials are never logged or returned.
 */

const { initializeApp, getApps, getApp, cert, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const config = require('../../config');
const logger = require('../../utils/logger');

const APP_NAME = 'bhoomiscan-auth';

class FirebaseAuthError extends Error {
  /**
   * @param {string} message  safe message for the client
   * @param {object} options
   * @param {number} options.statusCode  401 (token rejected), 403 (Firebase user disabled), 503 (config / Firebase unavailable)
   * @param {string} options.code        stable UPPER_SNAKE code
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'FirebaseAuthError';
    this.statusCode = options.statusCode || 401;
    this.code = options.code || 'INVALID_ID_TOKEN';
    this.firebaseCode = options.firebaseCode || null;
  }
}

const isConfigured = () => Boolean(config.firebase.projectId);

const getFirebaseApp = () => {
  if (getApps().some((app) => app.name === APP_NAME)) return getApp(APP_NAME);
  const { projectId, serviceAccount } = config.firebase;
  const options = { projectId };
  if (serviceAccount) options.credential = cert(serviceAccount);
  else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) options.credential = applicationDefault();
  return initializeApp(options, APP_NAME);
};

const TOKEN_ERRORS = {
  'auth/id-token-expired': [401, 'ID_TOKEN_EXPIRED', 'Google sign-in has expired, please sign in again'],
  'auth/id-token-revoked': [401, 'ID_TOKEN_REVOKED', 'Google sign-in was revoked, please sign in again'],
  'auth/user-disabled': [403, 'FIREBASE_USER_DISABLED', 'This Google account is disabled'],
  'auth/user-not-found': [401, 'INVALID_ID_TOKEN', 'Invalid Google sign-in token'],
};

/** Maps a firebase-admin error to FirebaseAuthError without leaking its message. */
const toFirebaseAuthError = (error) => {
  const code = String(error?.code || error?.errorInfo?.code || '');
  const mapped = TOKEN_ERRORS[code];
  if (mapped) {
    return new FirebaseAuthError(mapped[2], { statusCode: mapped[0], code: mapped[1], firebaseCode: code });
  }
  // Google public-key download failures surface as argument-error with this message.
  const unavailable =
    /fetching public keys/i.test(String(error?.message || '')) ||
    ['auth/internal-error', 'app/network-error', 'app/network-timeout', 'auth/invalid-credential', 'app/invalid-credential'].includes(code);
  if (unavailable) {
    logger.error({ firebaseCode: code || null, reason: error?.message }, '[GOOGLE LOGIN] Firebase Admin unavailable');
    return new FirebaseAuthError('Google sign-in is temporarily unavailable', { statusCode: 503, code: 'GOOGLE_AUTH_UNAVAILABLE', firebaseCode: code });
  }
  return new FirebaseAuthError('Invalid Google sign-in token', { statusCode: 401, code: 'INVALID_ID_TOKEN', firebaseCode: code || null });
};

/**
 * Verifies a Firebase ID token. Resolves with the verified identity:
 *   { uid, email, emailVerified, name, provider }
 * or throws FirebaseAuthError (401 / 403 / 503).
 */
const verifyIdToken = async (idToken) => {
  if (!isConfigured()) {
    throw new FirebaseAuthError('Google login is not configured on the server (FIREBASE_PROJECT_ID).', {
      statusCode: 503,
      code: 'GOOGLE_LOGIN_NOT_CONFIGURED',
    });
  }

  let decoded;
  try {
    decoded = await getAuth(getFirebaseApp()).verifyIdToken(idToken, config.firebase.checkRevoked);
  } catch (error) {
    throw toFirebaseAuthError(error);
  }

  return {
    uid: decoded.uid,
    email: typeof decoded.email === 'string' ? decoded.email.toLowerCase() : null,
    emailVerified: decoded.email_verified === true,
    name: typeof decoded.name === 'string' ? decoded.name.slice(0, 200) : null,
    provider: decoded.firebase?.sign_in_provider || null,
  };
};

module.exports = { verifyIdToken, isConfigured, FirebaseAuthError, __testing: { toFirebaseAuthError, getFirebaseApp, APP_NAME } };
