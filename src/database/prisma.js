/** Single PrismaClient for the process. */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient({
  // Query errors are thrown to callers (and logged by the error handler), so Prisma's
  // own error printing would only duplicate expected, handled errors (e.g. P2002).
  log: ['warn'],
});

const disconnect = () => prisma.$disconnect();

module.exports = { prisma, disconnect };
