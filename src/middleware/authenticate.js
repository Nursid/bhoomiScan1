/**
 * `authenticate`: requires `Authorization: Bearer <jwt>`, loads the user and
 * rejects blocked/deleted accounts. Sets req.user = { id, mobile, role } and req.auth = token claims.
 * `requireRole(role)`: must run after authenticate.
 */

const db = require('../database');
const tokens = require('../modules/auth/token.service');
const requestContext = require('../utils/requestContext');
const { unauthorized, forbidden } = require('../utils/errors');

const authenticate = async (req, res, next) => {
  const token = tokens.readBearerToken(req.headers);
  if (!token) {
    throw unauthorized('Authorization token is required', 'TOKEN_REQUIRED');
  }
  const claims = tokens.verifyToken(token);
  const user = await db.users.findById(String(claims.sub));
  if (!user) {
    throw unauthorized('Invalid login token', 'INVALID_TOKEN');
  }
  if (user.status !== 'ACTIVE') {
    throw forbidden('This account is blocked', 'ACCOUNT_BLOCKED');
  }
  req.user = { id: user.id, mobile: user.mobile, role: user.role };
  req.auth = claims;
  requestContext.set({ userId: user.id });
  next();
};

const requireRole = (role) => (req, res, next) => {
  if (!req.user || req.user.role !== role) {
    throw forbidden(`${role.toLowerCase()} access required`);
  }
  next();
};

module.exports = { authenticate, requireRole };
