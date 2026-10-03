/**
 * Shared outbound HTTP client used by every integration (Surepass, Razorpay,
 * MSG91, smart contract API). One place for:
 *
 *   - base URL + per-call auth headers (credentials never leave the integration)
 *   - timeouts (AbortController)
 *   - retries with exponential backoff for retryable failures only
 *   - error normalization into ProviderError via the integration's `mapError`
 *   - structured logging + sanitized audit rows (api_request_logs)
 *
 * The reference backend repeated fetch/timeout/JSON parsing in each client
 * (msg91Client.js, razorpayClient.js); this consolidates that pattern.
 */

const { ProviderError } = require('./errors');
const logger = require('./logger');
const apiAudit = require('./apiAudit');

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseBody = (text) => {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text.slice(0, 2000) };
  }
};

const retryAfterMs = (headers) => {
  const value = headers?.get?.('retry-after');
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), MAX_RETRY_AFTER_MS) : null;
};

const backoffMs = (attempt, baseDelayMs) => baseDelayMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseDelayMs);

/** Default error mapping when an integration does not supply one. */
const defaultMapError = (provider) => ({ status, body, timedOut, networkError }) => {
  if (timedOut) {
    return new ProviderError(504, 'PROVIDER_TIMEOUT', `${provider} did not respond in time`, { provider, retryable: true });
  }
  if (networkError) {
    return new ProviderError(502, 'PROVIDER_UNREACHABLE', `${provider} is unreachable`, {
      provider,
      retryable: true,
      providerMessage: networkError.message,
    });
  }
  return new ProviderError(502, 'PROVIDER_ERROR', `${provider} request failed`, {
    provider,
    providerStatus: status,
    providerBody: body,
    retryable: RETRYABLE_STATUS.has(status),
  });
};

/**
 * @param {object} options
 * @param {string} options.provider             e.g. "SUREPASS"
 * @param {() => string} options.baseUrl        read lazily so config/test overrides apply
 * @param {() => object} [options.headers]      auth + default headers, read per call
 * @param {number|(() => number)} options.timeoutMs
 * @param {(ctx) => ProviderError} [options.mapError]
 * @param {(status, body) => boolean} [options.isSuccess]  default: 2xx
 * @param {(body) => string|null} [options.extractReference]
 * @param {(body, ctx) => *} [options.auditResponseBody]   what to store in the audit log
 * @param {number} [options.baseDelayMs]
 * @param {typeof fetch} [options.fetchImpl]
 */
const createHttpClient = (options) => {
  const {
    provider,
    baseUrl,
    headers = () => ({}),
    mapError = defaultMapError(provider),
    isSuccess = (status) => status >= 200 && status < 300,
    extractReference = () => null,
    auditResponseBody = (body) => body,
    baseDelayMs = 300,
  } = options;
  const timeoutOf = () => (typeof options.timeoutMs === 'function' ? options.timeoutMs() : options.timeoutMs);
  const fetchImpl = () => options.fetchImpl || globalThis.fetch;

  /**
   * @param {object} req
   * @param {string} req.method
   * @param {string} req.path              path + optional query string
   * @param {*}      [req.body]            JSON body
   * @param {string} [req.rawBody]         pre-serialized body (form posts etc.)
   * @param {object} [req.headers]
   * @param {number} [req.retries=0]
   * @param {boolean} [req.retryOnTimeout] default true only when retries > 0 and method is GET
   * @param {string} [req.operation]       audit label
   * @param {*}      [req.auditRequestBody] override what gets stored for the request
   * @returns {Promise<{status:number, body:*, headers:Headers, durationMs:number, reference:string|null}>}
   */
  const request = async (req) => {
    const method = req.method.toUpperCase();
    const retries = Math.max(0, req.retries || 0);
    const retryOnTimeout = req.retryOnTimeout ?? method === 'GET';
    const url = `${baseUrl()}${req.path}`;
    const endpoint = req.path.split('?')[0];
    const operation = req.operation || `${method} ${endpoint}`;

    for (let attempt = 1; ; attempt += 1) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutOf());

      let response;
      let body = null;
      let failure = null;
      try {
        const requestHeaders = {
          accept: 'application/json',
          ...(req.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers(),
          ...(req.headers || {}),
        };
        // A header set to undefined by a call removes the default of the same name.
        Object.keys(requestHeaders).forEach((name) => requestHeaders[name] === undefined && delete requestHeaders[name]);
        response = await fetchImpl()(url, {
          method,
          headers: requestHeaders,
          body: req.rawBody ?? (req.body !== undefined ? JSON.stringify(req.body) : undefined),
          signal: controller.signal,
        });
        body = parseBody(await response.text());
      } catch (error) {
        const timedOut = error?.name === 'AbortError';
        failure = { error: mapError({ timedOut, networkError: timedOut ? null : error, attempt }), timedOut };
      } finally {
        clearTimeout(timer);
      }

      const durationMs = Date.now() - startedAt;
      if (!failure && !isSuccess(response.status, body)) {
        failure = { error: mapError({ status: response.status, body, headers: response.headers, attempt }) };
      }

      const reference = body ? extractReference(body) : null;
      apiAudit.record({
        provider,
        operation,
        method,
        endpoint,
        requestBody: req.auditRequestBody !== undefined ? req.auditRequestBody : req.body,
        responseStatus: response?.status ?? null,
        responseBody: body === null ? undefined : auditResponseBody(body, { success: !failure }),
        providerReference: reference,
        success: !failure,
        errorCode: failure?.error?.code,
        errorMessage: failure?.error?.providerMessage || failure?.error?.message,
        durationMs,
        attempt,
      });

      if (!failure) {
        logger.debug({ provider, operation, status: response.status, durationMs, attempt }, 'provider call ok');
        return { status: response.status, body, headers: response.headers, durationMs, reference };
      }

      const { error } = failure;
      const canRetry =
        attempt <= retries &&
        error.retryable !== false &&
        (failure.timedOut ? retryOnTimeout : !response || RETRYABLE_STATUS.has(response.status));

      logger.warn(
        {
          provider,
          operation,
          status: response?.status ?? null,
          code: error.code,
          providerMessage: error.providerMessage,
          durationMs,
          attempt,
          willRetry: canRetry,
        },
        'provider call failed',
      );

      if (!canRetry) {
        throw error;
      }
      await sleep(retryAfterMs(response?.headers) ?? backoffMs(attempt, baseDelayMs));
    }
  };

  return {
    request,
    get: (path, opts = {}) => request({ ...opts, method: 'GET', path }),
    post: (path, body, opts = {}) => request({ ...opts, method: 'POST', path, body }),
  };
};

module.exports = { createHttpClient, RETRYABLE_STATUS, __testing: { parseBody, retryAfterMs, backoffMs } };
