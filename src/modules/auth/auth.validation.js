const { z } = require('zod');
const { normalizeMobile } = require('../../utils/mobile');

const mobile = z
  .union([z.string(), z.number()])
  .transform((value, ctx) => {
    const parsed = normalizeMobile(value);
    if (!parsed) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid mobile number' });
      return z.NEVER;
    }
    return parsed.e164;
  });

const sendOtpSchema = z.object({ mobile }).strict();

const verifyOtpSchema = z
  .object({
    mobile,
    otp: z
      .union([z.string(), z.number()])
      .transform((value) => String(value).trim())
      .pipe(z.string().regex(/^\d{4,8}$/, 'OTP must be 4-8 digits')),
    // Only for the MSG91 widget flow.
    reqId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid reqId')
      .optional(),
    name: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

module.exports = { sendOtpSchema, verifyOtpSchema };
