/**
 * Centralized error handling. Clients get a stable { code, message, details? }
 * shape; stack traces, provider bodies and internal messages are only logged.
 */

const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

/** Catalyst data layer errors -> the same client codes the API returned before. */
const fromDataStore = (error) => {
  if (error?.name === 'DataStoreError') {
    if (/NOT_FOUND$/.test(error.code)) return new AppError(404, 'NOT_FOUND', 'Resource not found');
    return null; // programming / validation errors stay 500 (logged)
  }
  if (error?.name === 'CatalystError') {
    if (error.code === 'DUPLICATE_VALUE') return new AppError(409, 'CONFLICT', 'Resource already exists');
    if (['CATALYST_UNAVAILABLE', 'CATALYST_AUTH_FAILED', 'CATALYST_NOT_CONFIGURED'].includes(error.code) || error.status >= 500 || error.status === 429) {
      // The client only sees DATABASE_UNAVAILABLE; the cause goes to the log.
      return new AppError(503, 'DATABASE_UNAVAILABLE', 'Database is unavailable', { meta: { catalystCode: error.code, catalystStatus: error.status } });
    }
  }
  return null;
};

const fromBodyParser = (error) => {
  if (error?.type === 'entity.parse.failed') return new AppError(400, 'INVALID_JSON', 'Malformed JSON body');
  if (error?.type === 'entity.too.large') return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  return null;
};

const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.path} not found`,
    error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
    requestId: req.id,
  });
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const error = err instanceof AppError ? err : fromBodyParser(err) || fromDataStore(err);
  const log = req.log || logger;

  if (!error) {
    log.error({ err, requestId: req.id }, 'unhandled error');
    res.status(500).json({
      success: false,
      message: 'Something went wrong',
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
      requestId: req.id,
    });
    return;
  }

  const level = error.statusCode >= 500 ? 'error' : 'warn';
  log[level](
    {
      requestId: req.id,
      code: error.code,
      status: error.statusCode,
      provider: error.provider,
      providerStatus: error.providerStatus,
      providerMessage: error.providerMessage,
      meta: error.meta,
      // Mapped 5xx errors keep the original error in the log (Catalyst errors carry only code / message).
      ...(error.statusCode >= 500 && err !== error ? { err } : {}),
    },
    error.message,
  );

  if (error.retryAfter) {
    res.setHeader('Retry-After', String(error.retryAfter));
  }
  res.status(error.statusCode).json({
    success: false,
    message: error.message,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
    requestId: req.id,
  });
};

module.exports = { errorHandler, notFoundHandler };
