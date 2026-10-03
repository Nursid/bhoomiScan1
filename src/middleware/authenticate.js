/**
 * `authenticate`: requires `Authorization: Bearer <jwt>`, loads the user and
 * rejects blocked/deleted accounts. Sets req.user = { id, mobile, role }.
 * `requireRole(role)`: must run after authenticate.
 */

const { prisma } = require('../database/prisma');
const tokens = require('../modules/auth/token.service');
const requestContext = require('../utils/requestContext');
const { unauthorized, forbidden } = require('../utils/errors');

const authenticate = async (req, res, next) => {
  const token = tokens.readBearerToken(req.headers);
  if (!token) {
    throw unauthorized('Authorization token is required', 'TOKEN_REQUIRED');
  }
  const claims = tokens.verifyToken(token);
  const user = await prisma.user.findUnique({
    where: { id: String(claims.sub) },
    select: { id: true, mobile: true, role: true, status: true },
  });
  if (!user) {
    throw unauthorized('Invalid login token', 'INVALID_TOKEN');
  }
  if (user.status !== 'ACTIVE') {
    throw forbidden('This account is blocked', 'ACCOUNT_BLOCKED');
  }
  req.user = { id: user.id, mobile: user.mobile, role: user.role };
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
