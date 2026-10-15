require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { hashPassword } = require('../src/utils/password');

const prisma = new PrismaClient();

const main = async () => {
  const email = String(process.argv[2] || process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.argv[3] || process.env.ADMIN_PASSWORD || '');
  const name = String(process.argv[4] || process.env.ADMIN_NAME || 'Admin').trim();
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 8) {
    throw new Error('Usage: node scripts/create-admin.js <email> <password (min 8 chars)> [name]');
  }
  const passwordHash = hashPassword(password);
  const existing = await prisma.user.findFirst({ where: { email, role: 'ADMIN' } });
  if (existing) {
    await prisma.user.update({ where: { id: existing.id }, data: { passwordHash, name, status: 'ACTIVE' } });
    console.log(`Updated admin ${email}`);
  } else {
    await prisma.user.create({ data: { email, name, role: 'ADMIN', passwordHash } });
    console.log(`Created admin ${email}`);
  }
};

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());