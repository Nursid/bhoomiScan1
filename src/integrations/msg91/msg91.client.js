/**
 * MSG91 server-side client for the OTP Widget flow.
 * Ported from the reference backend's server/msg91Client.js (same behaviour).
 *
 * The UI runs the MSG91 widget's sendOtp() and gets a reqId. The user types the
 * OTP, and the backend verifies it with MSG91's widget verifyOtp API:
 *
 *   POST {MSG91_BASE_URL}/api/v5/widget/verifyOtp
 *   Content-Type: application/json
 *   { "widgetId": "<MSG91_WIDGET_ID>", "tokenAuth": "<MSG91_TOKEN_AUTH>", "reqId": "...", "otp": "..." }
 *
 * Observed live:
 *   already verified  -> { "message": "otp already verifed", "type": "error", "code": 703 }
 *   unknown reqId     -> { "message": "no request found",     "type": "error", "code": 709 }
 *   bad tokenAuth     -> { "message": "AuthenticationFailure","type": "error", "code": 401 }
 *   success           -> { "type": "success", ... }
 *
 * No OTP is generated, stored or compared here. Credentials are never logged or
 * returned. The OTP is never logged.
 */

const config = require('../../config');
const logger = require('../../utils/logger');

class Msg91Error extends Error {
  /**
   * @param {string} message      safe message for the client
   * @param {object} options
   * @param {number} options.statusCode  401 (OTP rejected), 502 (provider failure), 503 (our config)
   */
  constructor(message, options = {}) {
    super(message);
    this.name = 'Msg91Error';
    this.statusCode = options.statusCode || 502;
    this.providerMessage = options.providerMessage || null;
    this.providerCode = options.providerCode ?? null;
  }
}

/** Ready when the widget id and a credential (tokenAuth, or the account auth key) are present. */
const isConfigured = () => {
  const { widgetId, tokenAuth, authKey } = config.msg91;
  return Boolean(widgetId && (tokenAuth || authKey));
};

/** Redacts credential-looking strings before a debug log. */
const redactForLog = (value) => {
  const { tokenAuth, authKey } = config.msg91;
  let text = JSON.stringify(value) || '';
  [tokenAuth, authKey].filter(Boolean).forEach((secret) => {
    text = text.split(secret).join('<redacted>');
  });
  return text.replace(/[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '<redacted-token>');
};

const REJECTION_CODES = new Set(['702', '703', '705', '709', '710']);

const isOtpRejection = (body) => {
  const message = String(body?.message || '').toLowerCase();
  const code = String(body?.code || '');
  return (
    REJECTION_CODES.has(code) ||
    message.includes('otp') ||
    message.includes('no request found') ||
    message.includes('expired') ||
    message.includes('invalid') ||
    message.includes('attempt')
  );
};

const isCredentialFailure = (body) => {
  const message = String(body?.message || '').toLowerCase();
  const code = String(body?.code || '');
  return code === '401' || message.includes('authenticationfailure') || message.includes('authkey') || message.includes('tokenauth');
};

/**
 * Verifies `otp` for the widget request `reqId` with MSG91.
 * Resolves with { verified: true, identifier|null } or throws Msg91Error
 * with statusCode 401 / 502 / 503.
 */
const verifyWidgetOtp = async ({ reqId, otp }) => {
  const { widgetId, tokenAuth, authKey, baseUrl, timeoutMs, debugResponses } = config.msg91;

  if (!widgetId || (!tokenAuth && !authKey)) {
    throw new Msg91Error('Mobile OTP login is not configured on the server (MSG91).', { statusCode: 503 });
  }

  const headers = { 'content-type': 'application/json', accept: 'application/json' };
  const payload = { widgetId, reqId, otp };
  if (tokenAuth) {
    payload.tokenAuth = tokenAuth;
  } else {
    headers.authkey = authKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let text = '';
  try {
    response = await fetch(`${baseUrl}/api/v5/widget/verifyOtp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'MSG91 request timed out.' : error?.message;
    logger.warn({ reason }, '[MOBILE VERIFY] MSG91 verifyOtp unreachable');
    throw new Msg91Error('Unable to verify OTP with MSG91.', { statusCode: 502, providerMessage: reason });
  } finally {
    clearTimeout(timer);
  }

  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }

  if (!body || typeof body !== 'object') {
    logger.warn({ httpStatus: response.status }, '[MOBILE VERIFY] MSG91 verifyOtp returned a non-JSON response');
    throw new Msg91Error('Unable to verify OTP with MSG91.', { statusCode: 502, providerMessage: 'Malformed MSG91 response' });
  }

  if (debugResponses) {
    // Development aid only: response shape with credentials and tokens removed.
    logger.info({ response: redactForLog(body) }, '[MOBILE VERIFY] MSG91 verifyOtp response');
  }

  const type = String(body.type || '').toLowerCase();
  if (type !== 'success') {
    const providerMessage = String(body.message || 'MSG91 rejected the OTP');
    const providerCode = body.code ?? null;

    if (isCredentialFailure(body)) {
      logger.warn({ providerMessage }, '[MOBILE VERIFY] MSG91 rejected our widget credentials');
      throw new Msg91Error('Mobile OTP login is not configured on the server (MSG91).', { statusCode: 503, providerMessage, providerCode });
    }
    if (isOtpRejection(body) || response.ok) {
      logger.warn({ providerMessage, providerCode }, '[MOBILE VERIFY] MSG91 rejected the OTP');
      throw new Msg91Error('Invalid or expired OTP', { statusCode: 401, providerMessage, providerCode });
    }
    logger.warn({ providerMessage, httpStatus: response.status }, '[MOBILE VERIFY] MSG91 verifyOtp failed');
    throw new Msg91Error('Unable to verify OTP with MSG91.', { statusCode: 502, providerMessage, providerCode });
  }

  // MSG91 may or may not echo the identifier; when it does, the caller cross-checks it.
  const identifierCandidates = [body.identifier, body.mobile, body.data?.identifier, body.data?.mobile];
  const identifier = identifierCandidates.find((value) => typeof value === 'string' && value.trim()) || null;

  return { verified: true, identifier: identifier ? identifier.trim() : null };
};

module.exports = {
  Msg91Error,
  isConfigured,
  verifyWidgetOtp,
  __testing: { redactForLog, isOtpRejection, isCredentialFailure },
};
