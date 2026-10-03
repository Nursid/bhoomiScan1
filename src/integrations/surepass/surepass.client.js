/**
 * Surepass HTTP client. The only place that knows the Surepass base URL and token.
 *
 *   Authorization: Bearer <SUREPASS_TOKEN>
 *
 * Surepass envelopes every answer as
 *   { data, status_code, success, message, message_code }
 * and may report a failure with HTTP 200 + success:false, so success is decided
 * on both the HTTP status and `success`.
 *
 * Error normalization (what our API returns):
 *   401/403        -> 503 SUREPASS_AUTH_FAILED      (our credentials are invalid/expired)
 *   429            -> 429 SUREPASS_RATE_LIMITED     (retryable, Retry-After forwarded)
 *   404            -> 404 LAND_RECORD_NOT_FOUND
 *   400/422        -> 422 SUREPASS_REJECTED_REQUEST (provider's message passed through)
 *   500/502/503    -> 503 SUREPASS_UNAVAILABLE      (retryable)
 *   504 / timeout  -> 504 SUREPASS_TIMEOUT
 *   network error  -> 502 SUREPASS_UNREACHABLE
 */

const config = require('../../config');
const { createHttpClient } = require('../../utils/httpClient');
const { ProviderError, AppError } = require('../../utils/errors');

const PROVIDER = 'SUREPASS';

const isConfigured = () => Boolean(config.surepass.baseUrl && config.surepass.token);

const NOT_FOUND_HINTS = ['not found', 'no record', 'no data', 'does not exist', 'invalid khasra'];

const effectiveStatus = (status, body) => {
  // HTTP 200 with success:false carries the real status in status_code.
  if (status >= 200 && status < 300 && body?.success === false) {
    return Number(body.status_code) || 422;
  }
  return status;
};

const mapError = ({ status: httpStatus, body, headers, timedOut, networkError }) => {
  if (timedOut) {
    return new ProviderError(504, 'SUREPASS_TIMEOUT', 'Land record provider did not respond in time', { provider: PROVIDER, retryable: true });
  }
  if (networkError) {
    return new ProviderError(502, 'SUREPASS_UNREACHABLE', 'Land record provider is unreachable', {
      provider: PROVIDER,
      retryable: true,
      providerMessage: networkError.message,
    });
  }

  const status = effectiveStatus(httpStatus, body);
  const providerMessage = typeof body?.message === 'string' && body.message ? body.message : `http ${httpStatus}`;
  const messageCode = body?.message_code || null;
  const common = { provider: PROVIDER, providerStatus: status, providerMessage, providerBody: body };
  const safeDetails = { providerMessage, providerCode: messageCode };

  if (status === 401 || status === 403) {
    return new ProviderError(503, 'SUREPASS_AUTH_FAILED', 'Land record provider credentials are invalid or expired', common);
  }
  if (status === 429) {
    const retryAfter = Number(headers?.get?.('retry-after')) || 30;
    return new ProviderError(429, 'SUREPASS_RATE_LIMITED', 'Land record provider rate limit reached, please retry later', {
      ...common,
      retryable: true,
      retryAfter,
    });
  }
  const looksLikeNotFound = status >= 400 && status < 500 && NOT_FOUND_HINTS.some((hint) => providerMessage.toLowerCase().includes(hint));
  if (status === 404 || looksLikeNotFound) {
    return new ProviderError(404, 'LAND_RECORD_NOT_FOUND', 'No land record found for the given details', { ...common, details: safeDetails });
  }
  if (status === 400 || status === 422) {
    return new ProviderError(422, 'SUREPASS_REJECTED_REQUEST', 'Land record provider rejected the request', { ...common, details: safeDetails });
  }
  if (status === 504) {
    return new ProviderError(504, 'SUREPASS_TIMEOUT', 'Land record provider did not respond in time', { ...common, retryable: true });
  }
  if (status >= 500) {
    return new ProviderError(503, 'SUREPASS_UNAVAILABLE', 'Land record provider is temporarily unavailable', { ...common, retryable: true });
  }
  return new ProviderError(502, 'SUREPASS_ERROR', 'Land record provider returned an unexpected error', common);
};

class SurepassClient {
  constructor({ fetchImpl } = {}) {
    this.http = createHttpClient({
      provider: PROVIDER,
      baseUrl: () => config.surepass.baseUrl,
      timeoutMs: () => config.surepass.timeoutMs,
      headers: () => ({ authorization: `Bearer ${config.surepass.token}` }),
      isSuccess: (status, body) => status >= 200 && status < 300 && body?.success !== false,
      mapError,
      extractReference: (body) => body?.data?.client_id || null,
      // The full land record is persisted as a snapshot; the audit row keeps only the envelope.
      auditResponseBody: (body, { success }) =>
        success
          ? { status_code: body?.status_code, success: body?.success, message_code: body?.message_code, client_id: body?.data?.client_id }
          : body,
      fetchImpl,
    });
  }

  ensureConfigured() {
    if (!isConfigured()) {
      throw new AppError(503, 'SUREPASS_NOT_CONFIGURED', 'Land record provider is not configured on the server');
    }
  }

  async get(path, options = {}) {
    this.ensureConfigured();
    return this.http.get(path, options);
  }

  async post(path, body, options = {}) {
    this.ensureConfigured();
    return this.http.post(path, body, options);
  }
}

module.exports = { SurepassClient, isConfigured, __testing: { mapError, effectiveStatus } };
