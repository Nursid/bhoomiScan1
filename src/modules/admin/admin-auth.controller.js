const { z } = require('zod');
const { AppError } = require('../../utils/errors');
const service = require('./admin-auth.service');

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(1).max(200),
});

const login = async (req, res) => {
  const parsed = loginSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new AppError(400, 'INVALID_CREDENTIALS_FORMAT', 'Email and password are required');
  }
  res.json(await service.login(parsed.data));
};

module.exports = { login };