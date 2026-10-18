/**
 * Catalyst Data Store REST client (server-side, OAuth Self Client).
 *
 *   https://api.catalyst.zoho.in/baas/v1/project/{projectId}/...   header Environment: Development|Production
 *
 * Used instead of the Node SDK because the SDK on AppSail can only be initialised from
 * an incoming request, while background jobs and the migration tools have none.
 *
 * - access token refreshed from the refresh token, cached until shortly before expiry,
 *   refreshed once more on a 401
 * - retries 429 / 5xx / network errors with backoff (idempotent reads by default;
 *   writes only when the caller says so)
 * - never logs tokens or credentials
 */

const config = require('../../config');
const logger = require('../../utils/logger');

class CatalystError extends Error {
  constructor(message, { status = null, code = null, body = null } = {}) {
    super(message);
    this.name = 'CatalystError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

const isConfigured = () => {
  const c = config.catalyst;
  return Boolean(c.projectId && c.clientId && c.clientSecret && c.refreshToken);
};

let cachedToken = null; // { value, expiresAt }

// Development tools only (migration scripts, live tests): reuse a still-valid access token
// across processes so repeated runs stay under Zoho's token limit. Set
// CATALYST_TOKEN_CACHE_FILE to a path OUTSIDE the repository; never used on AppSail.
const fs = require('fs');

const tokenCacheFile = () => (config.isProduction ? null : process.env.CATALYST_TOKEN_CACHE_FILE || null);

const readCachedToken = () => {
  const file = tokenCacheFile();
  if (!file) return null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    return saved.clientId === config.catalyst.clientId && saved.expiresAt > Date.now() ? { value: saved.value, expiresAt: saved.expiresAt } : null;
  } catch {
    return null;
  }
};

const writeCachedToken = (token) => {
  const file = tokenCacheFile();
  if (!file) return;
  try {
    fs.writeFileSync(file, JSON.stringify({ ...token, clientId: config.catalyst.clientId }), { mode: 0o600 });
  } catch {
    // cache is an optimisation only
  }
};

const fetchToken = async ({ skipFileCache = false } = {}) => {
  const fromFile = skipFileCache ? null : readCachedToken();
  if (fromFile) {
    cachedToken = fromFile;
    return fromFile.value;
  }
  const c = config.catalyst;
  const response = await fetch(`${c.accountsUrl}/oauth/v2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: c.clientId, client_secret: c.clientSecret, refresh_token: c.refreshToken }),
    signal: AbortSignal.timeout(c.timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new CatalystError(`Catalyst token refresh failed (${body.error || `HTTP ${response.status}`})`, { status: 503, code: 'CATALYST_AUTH_FAILED' });
  }
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000 - 60000 };
  writeCachedToken(cachedToken);
  return cachedToken.value;
};

// Single-flight: concurrent requests share one refresh (Zoho allows ~10 per 10 minutes).
let inFlight = null;
const getToken = async (force = false) => {
  if (!force && cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  if (!inFlight) {
    inFlight = fetchToken({ skipFileCache: force }).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} method
 * @param {string} path     below /baas/v1/project/{projectId}, e.g. "/table"
 * @param {object} [options]
 * @param {*}      [options.body]         JSON body
 * @param {string} [options.environment]  Development | Production (default from config)
 * @param {number} [options.retries]      default: 2 for GET, 0 otherwise
 * @returns {Promise<*>} the `data` field of a successful response
 */
const request = async (method, path, { body, environment = config.catalyst.environment, retries } = {}) => {
  if (!isConfigured()) {
    throw new CatalystError('Catalyst Data Store is not configured (CATALYST_* settings)', { status: 503, code: 'CATALYST_NOT_CONFIGURED' });
  }
  const c = config.catalyst;
  const maxRetries = retries ?? (method === 'GET' ? 2 : 0);
  let refreshed = false;

  for (let attempt = 0; ; attempt += 1) {
    // Outside the network try/catch: an auth failure must surface as CATALYST_AUTH_FAILED.
    // Zoho issues at most ~10 access tokens per refresh token per 10 minutes, so it is cached.
    const token = await getToken();
    let response;
    try {
      response = await fetch(`${c.apiUrl}/baas/v1/project/${c.projectId}${path}`, {
        method,
        headers: {
          authorization: `Zoho-oauthtoken ${token}`,
          Environment: environment,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(c.timeoutMs),
      });
    } catch (error) {
      if (attempt < maxRetries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw new CatalystError(`Catalyst request failed: ${error.name === 'TimeoutError' ? 'timeout' : 'network error'}`, { status: 503, code: 'CATALYST_UNAVAILABLE' });
    }

    const text = await response.text();
    let json;
    try {
      // System ids exceed Number.MAX_SAFE_INTEGER: keep them exact as strings.
      json = text ? JSON.parse(text.replace(/"(ROWID|CREATORID|table_id|column_id)":(d{16,})/g, '"$1":"$2"')) : {};
    } catch {
      json = { raw: text.slice(0, 500) };
    }

    if (response.status === 401 && !refreshed) {
      refreshed = true;
      await getToken(true);
      attempt -= 1;
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
      await sleep(Number(response.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt);
      continue;
    }
    if (!response.ok || json.status === 'failure') {
      const code = json?.data?.error_code || json?.error_code || `HTTP_${response.status}`;
      const message = json?.data?.message || json?.message || `HTTP ${response.status}`;
      logger.warn({ method, path, status: response.status, code }, 'catalyst request failed');
      // Only the error code / message are kept: a full response could contain row data.
      throw new CatalystError(`Catalyst: ${message}`, { status: response.status, code, body: { error_code: code, message } });
    }
    return json.data;
  }
};

module.exports = { request, isConfigured, CatalystError, __testing: { resetToken: () => (cachedToken = null) } };
