/**
 * Centralized error handling. Clients get a stable { code, message, details? }
 * shape; stack traces, provider bodies and internal messages are only logged.
 */

const { Prisma } = require('@prisma/client');
const { AppError } = require('../utils/errors');
const logger = require('../utils/logger');

const fromPrisma = (error) => {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') return new AppError(409, 'CONFLICT', 'Resource already exists');
    if (error.code === 'P2025') return new AppError(404, 'NOT_FOUND', 'Resource not found');
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return new AppError(503, 'DATABASE_UNAVAILABLE', 'Database is unavailable');
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
    error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.path} not found` },
    requestId: req.id,
  });
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  const error = err instanceof AppError ? err : fromBodyParser(err) || fromPrisma(err);
  const log = req.log || logger;

  if (!error) {
    log.error({ err, requestId: req.id }, 'unhandled error');
    res.status(500).json({
      success: false,
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
      ...(error.statusCode >= 500 && err !== error ? { err } : {}),
    },
    error.message,
  );

  if (error.retryAfter) {
    res.setHeader('Retry-After', String(error.retryAfter));
  }
  res.status(error.statusCode).json({
    success: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
    requestId: req.id,
  });
};

module.exports = { errorHandler, notFoundHandler };
