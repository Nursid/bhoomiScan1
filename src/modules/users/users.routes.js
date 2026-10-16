const { Router } = require('express');
const { z } = require('zod');
const { prisma } = require('../../database/prisma');
const { authenticate } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { ok } = require('../../utils/response');
const { publicUser, profileStatus, completeProfile } = require('../auth/auth.service');
const { otpVerifyLimiters } = require('../../middleware/rateLimiters');
const subscriptionsService = require('../subscriptions/subscriptions.service');

const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'No updatable fields provided');

// Letters in any script (Hindi, Punjabi, ...) plus spaces, dots, apostrophes and hyphens.
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;

const stringOrNumber = z.union([z.string(), z.number()]).transform((value) => String(value).trim());

const profileSchema = z
  .object({
    name: z
      .string()
      .transform((value) => value.trim().replace(/\s+/g, ' '))
      .pipe(z.string().min(2, 'Enter your full name').max(100, 'Name is too long').regex(NAME_PATTERN, "Name can only contain letters, spaces and . ' -"))
      .optional(),
    // Optional; "" or null removes it.
    email: z
      .union([z.literal(''), z.null(), z.string().trim().toLowerCase().email('Invalid email').max(200)])
      .transform((value) => value || null)
      .optional(),
    // Only for accounts without a mobile number (Google sign-up), with the MSG91 widget OTP.
    mobile: stringOrNumber.optional(),
    otp: stringOrNumber.optional(),
    reqId: z.string().trim().max(64).optional(),
  })
  .strict();

const router = Router();

router.use(authenticate);

router.get('/me', async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id } });
  const subscription = await subscriptionsService.findActiveSubscription(user.id);
  ok(res, {
    user: publicUser(user),
    profile: profileStatus(user),
    activeSubscription: subscription ? subscriptionsService.publicSubscription(subscription) : null,
  });
});

/**
 * Complete / update the profile after login.
 *   Google sign-up:  { name, mobile, otp, reqId }   (mobile proven with the MSG91 widget OTP)
 *   Mobile sign-up:  { name, email? }               (email optional)
 */
router.put('/me/profile', validate({ body: profileSchema }), ...otpVerifyLimiters, async (req, res) =>
  ok(res, await completeProfile(req.user.id, req.body)),
);

router.patch('/me', validate({ body: updateMeSchema }), async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.user.id }, data: req.body });
  ok(res, { user: publicUser(user) });
});

module.exports = router;
