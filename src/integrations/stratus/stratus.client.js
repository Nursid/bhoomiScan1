const config = require('../../config');
const { serviceUnavailable } = require('../../utils/errors');

const OAUTH_URL = `${config.stratus.accountsUrl}/oauth/v2/token`;
let cachedAccessToken = null;
let tokenExpiresAt = 0;
let tokenRequest = null;

const isConfigured = () => Boolean(
  config.stratus.bucketName && config.stratus.bucketUrl
  && config.stratus.oauthClientId && config.stratus.oauthClientSecret && config.stratus.oauthRefreshToken,
);

const assertConfigured = () => {
  if (!isConfigured()) throw serviceUnavailable('Stratus storage is not configured', 'STRATUS_NOT_CONFIGURED');
  let bucketUrl;
  try {
    bucketUrl = new URL(config.stratus.bucketUrl);
  } catch {
    throw serviceUnavailable('Stratus bucket configuration is invalid', 'STRATUS_CONFIGURATION_INVALID');
  }
  const bucketPrefix = `${config.stratus.bucketName}-development.`;
  if (bucketUrl.protocol !== 'https:' || bucketUrl.username || bucketUrl.password || bucketUrl.search || bucketUrl.hash
    || bucketUrl.pathname !== '/' || !bucketUrl.hostname.startsWith(bucketPrefix) || !bucketUrl.hostname.endsWith('.zohostratus.in')) {
    throw serviceUnavailable('Stratus bucket configuration is invalid', 'STRATUS_CONFIGURATION_INVALID');
  }
  return bucketUrl;
};

const refreshAccessToken = async (force = false) => {
  if (!force && cachedAccessToken && Date.now() < tokenExpiresAt - 60_000) return cachedAccessToken;
  if (tokenRequest) return tokenRequest;
  tokenRequest = (async () => {
    const form = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.stratus.oauthRefreshToken,
      client_id: config.stratus.oauthClientId,
      client_secret: config.stratus.oauthClientSecret,
    });
    let response;
    try {
      response = await fetch(OAUTH_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(config.stratus.timeoutMs),
        redirect: 'error',
      });
      const body = await response.json();
      if (!response.ok || typeof body.access_token !== 'string' || !Number.isFinite(Number(body.expires_in))) {
        throw new Error('OAuth token refresh rejected');
      }
      cachedAccessToken = body.access_token;
      tokenExpiresAt = Date.now() + Number(body.expires_in) * 1000;
      return cachedAccessToken;
    } catch {
      cachedAccessToken = null;
      tokenExpiresAt = 0;
      throw serviceUnavailable('Stratus authentication is unavailable', 'STRATUS_AUTH_FAILED');
    } finally {
      tokenRequest = null;
    }
  })();
  return tokenRequest;
};

const objectUrl = (bucketUrl, key) => {
  if (typeof key !== 'string' || !key || key.length > 255 || key.startsWith('/') || key.includes('..')
    || /["<>#\\|\s]/.test(key)) {
    throw serviceUnavailable('Stratus object reference is invalid', 'STRATUS_OBJECT_REFERENCE_INVALID');
  }
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  return new URL(encodedKey, bucketUrl).toString();
};

const authorizedFetch = async (url, options) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const accessToken = await refreshAccessToken(attempt === 1);
    let response;
    try {
      response = await fetch(url, {
        ...options,
        headers: { ...options.headers, authorization: `Zoho-oauthtoken ${accessToken}` },
        signal: AbortSignal.timeout(config.stratus.timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw serviceUnavailable('Stratus storage request failed', 'STRATUS_REQUEST_FAILED');
    }
    if (response.status !== 401 || attempt === 1) return response;
    cachedAccessToken = null;
    tokenExpiresAt = 0;
  }
  throw serviceUnavailable('Stratus authentication is unavailable', 'STRATUS_AUTH_FAILED');
};

const sanitizedResponseMessage = async (response, objectKey) => {
  let body;
  try {
    body = await response.json();
  } catch {
    return '';
  }
  const candidate = [body?.data?.message, body?.message, body?.error_description, body?.error, body?.code]
    .find((value) => typeof value === 'string');
  if (!candidate) return '';

  let message = candidate.replace(/[\r\n\t]+/g, ' ');
  [config.stratus.oauthClientId, config.stratus.oauthClientSecret, config.stratus.oauthRefreshToken, cachedAccessToken, objectKey]
    .filter((secret) => typeof secret === 'string' && secret.length > 0)
    .forEach((secret) => { message = message.split(secret).join('[redacted]'); });
  message = message.replace(/Zoho-oauthtoken\s+[^\s,;"']+/gi, 'Zoho-oauthtoken [redacted]');
  return message.slice(0, 180);
};

const providerFailure = async (response, operation, code, objectKey) => {
  const responseMessage = await sanitizedResponseMessage(response, objectKey);
  const detail = responseMessage ? `: ${responseMessage}` : '';
  throw serviceUnavailable(`${operation} failed (HTTP ${response.status}${detail})`, code);
};

const upload = async ({ key, bytes, contentType }) => {
  const bucketUrl = assertConfigured();
  const response = await authorizedFetch(objectUrl(bucketUrl, key), {
    method: 'PUT',
    headers: {
      'content-type': contentType,
      'content-length': String(bytes.length),
      'cache-control': 'private, no-store',
    },
    body: bytes,
  });
  if (!response.ok) await providerFailure(response, 'Stratus upload', 'STRATUS_UPLOAD_FAILED', key);
  return { objectKey: key };
};

const download = async ({ key, expectedSize }) => {
  const bucketUrl = assertConfigured();
  const response = await authorizedFetch(objectUrl(bucketUrl, key), { method: 'GET' });
  if (!response.ok) await providerFailure(response, 'Stratus download', 'STRATUS_DOWNLOAD_FAILED', key);
  const statedLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(statedLength) && statedLength > config.stratus.maxFileBytes) {
    throw serviceUnavailable('Stored document exceeds the upload limit', 'STRATUS_FILE_TOO_LARGE');
  }
  if (!response.body) throw serviceUnavailable('Stored document is unavailable', 'STRATUS_DOWNLOAD_FAILED');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > config.stratus.maxFileBytes || size > expectedSize) {
        await reader.cancel();
        throw serviceUnavailable('Stored document size does not match its record', 'STRATUS_FILE_SIZE_MISMATCH');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error?.code?.startsWith('STRATUS_')) throw error;
    throw serviceUnavailable('Stored document download failed', 'STRATUS_DOWNLOAD_FAILED');
  }
  if (size !== expectedSize) throw serviceUnavailable('Stored document size does not match its record', 'STRATUS_FILE_SIZE_MISMATCH');
  return Buffer.concat(chunks, size);
};

// This is used only to compensate a just-uploaded object whose database insert failed.
// Keys are generated uniquely per attempted document, so this cannot remove an existing version.
const deleteUnreferenced = async (key) => {
  assertConfigured();
  if (!config.stratus.projectId) throw serviceUnavailable('Stratus project ID is not configured', 'STRATUS_NOT_CONFIGURED');
  const url = new URL(`/baas/v1/project/${encodeURIComponent(config.stratus.projectId)}/bucket/object`, config.stratus.apiUrl);
  url.searchParams.set('bucket_name', config.stratus.bucketName);
  const response = await authorizedFetch(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', environment: 'Development' },
    body: JSON.stringify({ objects: [{ key }], ttl_in_seconds: 60 }),
  });
  if (!response.ok) await providerFailure(response, 'Stratus cleanup', 'STRATUS_CLEANUP_FAILED', key);
  return true;
};

const resetTokenCache = () => { cachedAccessToken = null; tokenExpiresAt = 0; tokenRequest = null; };

module.exports = { upload, download, deleteUnreferenced, isConfigured, __testing: { objectUrl, refreshAccessToken, assertConfigured, resetTokenCache } };
