/**
 * Safe database diagnostics. Never returns or logs the connection string,
 * username or password: only metadata (host, database, ssl, pooled) and Prisma
 * errors with any URL / credential stripped.
 */

const config = require('../config');

/** Shape of DATABASE_URL without secrets, for startup / failure logs. */
const describeDatabaseUrl = (raw = config.databaseUrl) => {
  const value = raw || '';
  const info = {
    present: Boolean(value),
    source: config.databaseUrlSource,
    hasSurroundingQuotes: /^\s*["']|["']\s*$/.test(value),
    hasSurroundingWhitespace: value !== value.trim(),
  };
  if (!value) return info;
  try {
    const url = new URL(value.trim().replace(/^["']|["']$/g, ''));
    return {
      ...info,
      protocol: url.protocol.replace(':', ''),
      host: url.hostname,
      port: url.port || '5432',
      database: url.pathname.replace(/^\//, '') || null,
      sslmode: url.searchParams.get('sslmode'),
      pooled: url.hostname.includes('-pooler'),
      isLocalhost: ['localhost', '127.0.0.1', '::1'].includes(url.hostname),
    };
  } catch {
    return { ...info, parseable: false };
  }
};

const URL_PATTERN = /\b(postgres(?:ql)?|prisma(?:\+postgres)?):\/\/[^\s"'`]+/gi;
const CREDENTIALS_PATTERN = /\/\/[^/\s:@]+:[^/\s@]+@/g;

const sanitize = (text) =>
  String(text || '')
    .replace(URL_PATTERN, '$1://<redacted>')
    .replace(CREDENTIALS_PATTERN, '//<redacted>@')
    .trim();

/** Prisma error -> { name, code, message } safe to log. */
const describeDbError = (error) => ({
  name: error?.name || 'Error',
  code: error?.errorCode || error?.code || null,
  message: sanitize(error?.message).slice(0, 2000),
});

module.exports = { describeDatabaseUrl, describeDbError };
