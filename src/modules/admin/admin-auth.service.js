const { prisma } = require('../../database/prisma');
const logger = require('../../utils/logger');
const { AppError } = require('../../utils/errors');
const { verifyPassword } = require('../../utils/password');
const tokens = require('../auth/token.service');
const { publicUser } = require('../auth/auth.service');

const DUMMY_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

const invalidLogin = () => new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');

const login = async ({ email, password }) => {
  const user = await prisma.user.findFirst({ where: { email, role: 'ADMIN' } });
  const passwordOk = verifyPassword(password, user?.passwordHash || DUMMY_HASH);
  if (!user || !user.passwordHash || !passwordOk) {
    throw invalidLogin();
  }
  if (user.status !== 'ACTIVE') {
    throw new AppError(403, 'ACCOUNT_BLOCKED', 'This account is blocked');
  }
  const updated = await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  const { token, expiresAt } = tokens.generateToken({ ...updated, loginMethod: 'admin_password' });
  logger.info({ userId: user.id }, 'admin logged in');
  return { success: true, token, expiresAt, user: publicUser(updated) };
};

module.exports = { login };