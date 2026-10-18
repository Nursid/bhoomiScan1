/**
 * Persists sanitized outbound-call records to api_request_logs. Never throws and
 * never blocks the caller: an audit failure must not fail a business operation.
 */

const { randomUUID } = require('crypto');
const logger = require('./logger');
const requestContext = require('./requestContext');
const { sanitize } = require('./sanitize');

// Catalyst Text columns hold 10,000 characters; JSON escaping can grow a preview, so the
// stored value is kept well below that.
const MAX_BODY_CHARS = 4000;

const clip = (value) => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const safe = sanitize(value);
  const text = JSON.stringify(safe);
  return text && text.length > MAX_BODY_CHARS ? { truncated: true, preview: text.slice(0, MAX_BODY_CHARS) } : safe;
};

const record = (entry) => {
  // Lazy require keeps this util usable in unit tests without a database.
  let db;
  let catalyst;
  try {
    db = require('../database');
    catalyst = require('../database/catalyst/client');
  } catch {
    return;
  }
  if (process.env.DATA_BACKEND !== 'memory' && !catalyst.isConfigured()) {
    return;
  }
  const context = requestContext.get();
  const data = {
    id: randomUUID(),
    userId: entry.userId || context.userId || null,
    requestId: context.requestId || null,
    provider: entry.provider,
    operation: entry.operation || 'request',
    method: entry.method,
    endpoint: entry.endpoint,
    requestBody: clip(entry.requestBody),
    responseStatus: entry.responseStatus ?? null,
    responseBody: clip(entry.responseBody),
    providerReference: entry.providerReference || null,
    success: Boolean(entry.success),
    errorCode: entry.errorCode || null,
    errorMessage: entry.errorMessage ? String(entry.errorMessage).slice(0, 1000) : null,
    durationMs: Math.round(entry.durationMs || 0),
    attempt: entry.attempt || 1,
  };

  db.apiRequestLogs.insert(data).catch((error) => {
    logger.warn({ err: error.message, provider: data.provider }, 'Could not write api request log');
  });
};

module.exports = { record };
