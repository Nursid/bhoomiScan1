/**
 * Application errors. Anything thrown that is not an AppError is treated as an
 * unexpected 500 by the error handler and its message is never sent to clients.
 */

class AppError extends Error {
  /**
   * @param {number} statusCode HTTP status
   * @param {string} code       stable machine-readable code (UPPER_SNAKE)
   * @param {string} message    safe, client-facing message
   * @param {object} [options]
   * @param {*}      [options.details]     safe extra info for the client
   * @param {object} [options.meta]        internal info (logged, never returned)
   * @param {number} [options.retryAfter]  seconds, sent as Retry-After
   * @param {Error}  [options.cause]
   */
  constructor(statusCode, code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.meta = options.meta;
    this.retryAfter = options.retryAfter;
  }
}

const badRequest = (message, details, code = 'BAD_REQUEST') => new AppError(400, code, message, { details });
const unauthorized = (message = 'Authentication required', code = 'UNAUTHORIZED') => new AppError(401, code, message);
const forbidden = (message = 'Access denied', code = 'FORBIDDEN', details) => new AppError(403, code, message, { details });
const notFound = (message = 'Resource not found', code = 'NOT_FOUND') => new AppError(404, code, message);
const conflict = (message, details, code = 'CONFLICT') => new AppError(409, code, message, { details });
const unprocessable = (message, details, code = 'UNPROCESSABLE_ENTITY') => new AppError(422, code, message, { details });
const serviceUnavailable = (message, code = 'SERVICE_UNAVAILABLE') => new AppError(503, code, message);

/**
 * Error from an outbound integration (Surepass, Razorpay, MSG91, smart contract).
 * `retryable` tells job runners whether a later attempt may succeed.
 */
class ProviderError extends AppError {
  constructor(statusCode, code, message, options = {}) {
    super(statusCode, code, message, options);
    this.name = 'ProviderError';
    this.provider = options.provider;
    this.providerStatus = options.providerStatus ?? null;
    this.providerMessage = options.providerMessage ?? null;
    this.providerBody = options.providerBody;
    this.retryable = Boolean(options.retryable);
  }
}

module.exports = {
  AppError,
  ProviderError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  serviceUnavailable,
};
