/**
 * JWT issuing/verification (HS256). Adapted from the reference backend's
 * server/authTokens.js; the subject is now the database user id (uuid) instead
 * of the mobile number, because this service has a users table.
 */

const jwt = require('jsonwebtoken');
const config = require('../../config');
const { AppError, unauthorized } = require('../../utils/errors');

const ensureConfigured = () => {
  if (!config.jwt.isConfigured) {
    throw new AppError(503, 'AUTH_NOT_CONFIGURED', 'Login tokens are not configured on the server');
  }
};

const generateToken = (user) => {
  ensureConfigured();
  const token = jwt.sign({ mobile: user.mobile, role: user.role }, config.jwt.secret, {
    algorithm: 'HS256',
    subject: String(user.id),
    issuer: config.jwt.issuer,
    expiresIn: config.jwt.expiresIn,
  });
  const { exp } = jwt.decode(token);
  return { token, expiresAt: new Date(exp * 1000) };
};

const verifyToken = (token) => {
  ensureConfigured();
  try {
    return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], issuer: config.jwt.issuer });
  } catch (error) {
    if (error?.name === 'TokenExpiredError') {
      throw unauthorized('Login token has expired', 'TOKEN_EXPIRED');
    }
    throw unauthorized('Invalid login token', 'INVALID_TOKEN');
  }
};

const readBearerToken = (headers) => {
  const match = /^Bearer\s+(.+)$/i.exec(String(headers?.authorization || '').trim());
  return match ? match[1].trim() : null;
};

module.exports = { generateToken, verifyToken, readBearerToken };
