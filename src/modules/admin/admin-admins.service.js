const { prisma } = require('../../database/prisma');
const { conflict, badRequest } = require('../../utils/errors');
const { normalizeMobile } = require('../../utils/mobile');
const { hashPassword } = require('../../utils/password');

const createAdmin = async ({ name, email, phone, password }) => {
  const mobile = normalizeMobile(phone);
  if (!mobile) {
    throw badRequest('Invalid phone number', undefined, 'INVALID_MOBILE');
  }
  const [sameEmail, sameMobile] = await Promise.all([
    prisma.user.findFirst({ where: { email, role: 'ADMIN' } }),
    prisma.user.findUnique({ where: { mobile: mobile.e164 } }),
  ]);
  if (sameEmail) throw conflict('An admin with this email already exists', undefined, 'ADMIN_EMAIL_EXISTS');
  if (sameMobile) throw conflict('This phone number is already registered', undefined, 'MOBILE_EXISTS');

  const admin = await prisma.user.create({
    data: { name, email, mobile: mobile.e164, role: 'ADMIN', passwordHash: hashPassword(password) },
  });
  return { id: admin.id, name: admin.name, email: admin.email, phone: admin.mobile, role: admin.role, status: admin.status, createdAt: admin.createdAt };
};

module.exports = { createAdmin };