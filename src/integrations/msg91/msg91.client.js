/**
 * MSG91 OTP client.
 *
 *   sendOtp    POST {base}/api/v5/otp?template_id=&mobile=&otp_expiry=&otp_length=   (header authkey)
 *   verifyOtp  GET  {base}/api/v5/otp/verify?mobile=&otp=                            (header authkey)
 *   verifyWidgetOtp POST {base}/api/v5/widget/verifyOtp { widgetId, tokenAuth, reqId, otp }
 *
 * MSG91 generates, stores and checks the OTP; this backend never stores it.
 * MSG91 answers HTTP 200 with { type: "success" | "error", message } for most
 * outcomes, so success is decided on `type`. The OTP travels in the query string
 * (MSG91's API design); audit logs only keep the path, never the query.
 *
 * Widget error behaviour (observed in the reference project): 703 already verified,
 * 709 unknown reqId, 401 bad tokenAuth.
 */

const config = require('../../config');
const { createHttpClient } = require('../../utils/httpClient');
const { ProviderError, AppError } = require('../../utils/errors');

const PROVIDER = 'MSG91';

const isConfigured = () => Boolean(config.msg91.authKey && config.msg91.templateId);
const isWidgetConfigured = () => Boolean(config.msg91.widgetId && config.msg91.widgetTokenAuth);

const CREDENTIAL_HINTS = ['authenticationfailure', 'authkey', 'tokenauth', 'invalid auth'];

const isCredentialFailure = (body, status) => {
  const message = String(body?.message || '').toLowerCase();
  return status === 401 || String(body?.code) === '401' || CREDENTIAL_HINTS.some((hint) => message.includes(hint));
};

const mapError = ({ status, body, timedOut, networkError }) => {
  if (timedOut || networkError) {
    return new ProviderError(502, 'OTP_PROVIDER_UNAVAILABLE', 'OTP service is temporarily unavailable', {
      provider: PROVIDER,
      retryable: true,
      providerMessage: timedOut ? 'timeout' : networkError.message,
    });
  }
  const providerMessage = String(body?.message || `http ${status}`);
  if (isCredentialFailure(body, status)) {
    return new ProviderError(503, 'OTP_PROVIDER_MISCONFIGURED', 'OTP service is not configured correctly', {
      provider: PROVIDER,
      providerStatus: status,
      providerMessage,
    });
  }
  if (status >= 500) {
    return new ProviderError(502, 'OTP_PROVIDER_UNAVAILABLE', 'OTP service is temporarily unavailable', {
      provider: PROVIDER,
      providerStatus: status,
      providerMessage,
      retryable: true,
    });
  }
  // Remaining "type: error" answers are OTP rejections (wrong, expired, max attempts, unknown reqId).
  return new ProviderError(401, 'INVALID_OTP', 'Invalid or expired OTP', {
    provider: PROVIDER,
    providerStatus: status,
    providerMessage,
  });
};

const client = createHttpClient({
  provider: PROVIDER,
  baseUrl: () => config.msg91.baseUrl,
  timeoutMs: () => config.msg91.timeoutMs,
  headers: () => (config.msg91.authKey ? { authkey: config.msg91.authKey } : {}),
  isSuccess: (status, body) => status >= 200 && status < 300 && String(body?.type || '').toLowerCase() === 'success',
  mapError,
  // Only keep type/message/code: success bodies may echo request data.
  auditResponseBody: (body) => ({ type: body?.type, message: body?.message, code: body?.code }),
});

const requireConfigured = () => {
  if (!isConfigured()) {
    throw new AppError(503, 'OTP_NOT_CONFIGURED', 'OTP login is not configured on the server');
  }
};

/** @param {string} digits mobile with country code, no "+" (e.g. 917081002501) */
const sendOtp = async (digits) => {
  requireConfigured();
  const params = new URLSearchParams({
    template_id: config.msg91.templateId,
    mobile: digits,
    otp_expiry: String(config.msg91.otpExpiryMinutes),
    otp_length: String(config.msg91.otpLength),
  });
  const { body } = await client.post(`/api/v5/otp?${params}`, {}, { operation: 'otp.send', auditRequestBody: { mobile: `***${digits.slice(-4)}` } });
  return { requestId: body?.request_id || null };
};

const verifyOtp = async (digits, otp) => {
  requireConfigured();
  const params = new URLSearchParams({ mobile: digits, otp });
  await client.get(`/api/v5/otp/verify?${params}`, { operation: 'otp.verify', auditRequestBody: { mobile: `***${digits.slice(-4)}` } });
  return { verified: true };
};

/** Widget flow: the client ran the MSG91 widget's sendOtp() and holds a reqId. */
const verifyWidgetOtp = async (reqId, otp) => {
  if (!isWidgetConfigured()) {
    throw new AppError(503, 'OTP_NOT_CONFIGURED', 'OTP widget login is not configured on the server');
  }
  const { body } = await client.request({
    method: 'POST',
    path: '/api/v5/widget/verifyOtp',
    body: { widgetId: config.msg91.widgetId, tokenAuth: config.msg91.widgetTokenAuth, reqId, otp },
    headers: { authkey: undefined },
    operation: 'otp.widget.verify',
    auditRequestBody: { reqId },
  });
  const candidates = [body?.identifier, body?.mobile, body?.data?.identifier, body?.data?.mobile];
  const identifier = candidates.find((value) => typeof value === 'string' && value.trim()) || null;
  return { verified: true, identifier };
};

module.exports = { isConfigured, isWidgetConfigured, sendOtp, verifyOtp, verifyWidgetOtp, __testing: { mapError } };
