/**
 * Firebase Cloud Messaging (push to Android / iOS / web) through Firebase Admin.
 *
 * Reuses the one Firebase Admin app initialised for Google login. FCM needs a
 * credential (FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS);
 * without one `isConfigured()` is false and nothing is sent.
 *
 * `sendToTokens` reports, per call, how many devices accepted the message and
 * which tokens are dead (uninstalled app, expired token) so the caller can drop
 * them. Device tokens are never logged.
 */

const { getMessaging } = require('firebase-admin/messaging');
const config = require('../../config');
const { getFirebaseApp } = require('./firebase-admin.client');

const MAX_TOKENS_PER_CALL = 500; // FCM multicast limit

// Errors meaning "this token will never work again".
const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

const isConfigured = () => config.push.enabled;

/** FCM data values must be strings. */
const stringifyData = (data = {}) =>
  Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
  );

/**
 * @param {string[]} tokens
 * @param {{ title: string, body: string, data?: object }} message
 * @returns {Promise<{ delivered: number, deadTokens: string[], transientErrors: string[] }>}
 */
const sendToTokens = async (tokens, { title, body, data }) => {
  const messaging = getMessaging(getFirebaseApp());
  const result = { delivered: 0, deadTokens: [], transientErrors: [] };

  for (let i = 0; i < tokens.length; i += MAX_TOKENS_PER_CALL) {
    const batch = tokens.slice(i, i + MAX_TOKENS_PER_CALL);
    const response = await messaging.sendEachForMulticast({
      tokens: batch,
      notification: { title, body },
      data: stringifyData(data),
      android: { priority: 'high', notification: { channelId: 'land_updates', sound: 'default' } },
      apns: { payload: { aps: { sound: 'default' } } },
    });
    response.responses.forEach((item, index) => {
      if (item.success) {
        result.delivered += 1;
      } else if (DEAD_TOKEN_CODES.has(item.error?.code)) {
        result.deadTokens.push(batch[index]);
      } else {
        result.transientErrors.push(item.error?.code || 'unknown');
      }
    });
  }
  return result;
};

module.exports = { isConfigured, sendToTokens, __testing: { stringifyData, DEAD_TOKEN_CODES } };
