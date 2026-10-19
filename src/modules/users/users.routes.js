const { Router } = require('express');
const { z } = require('zod');
const { prisma } = require('../../database/prisma');
const { authenticate } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { ok } = require('../../utils/response');
const { publicUser, profileStatus, completeProfile, updateProfile } = require('../auth/auth.service');
const { otpVerifyLimiters } = require('../../middleware/rateLimiters');
const subscriptionsService = require('../subscriptions/subscriptions.service');

const stringOrNumber = z.union([z.string(), z.number()]).transform((value) => String(value).trim());

const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
    // No OTP needed: saved as the contact number (see auth.service mobileChange).
    mobile: z.union([stringOrNumber, z.null()]).optional(),
    otp: stringOrNumber.optional(),
    reqId: z.string().trim().max(64).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'No updatable fields provided');

// Letters in any script (Hindi, Punjabi, ...) plus spaces, dots, apostrophes and hyphens.
const NAME_PATTERN = /^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u;

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
    // Optional. Without otp/reqId it is saved as the contact number (no OTP needed);
    // with the MSG91 widget otp + reqId it is verified and also becomes a login number.
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

// OTP attempts stay rate limited; plain profile edits are not.
const limitOtpAttempts = (req, res, next) => {
  if (req.body.otp === undefined) return next();
  const [byMobile, byIp] = otpVerifyLimiters;
  return byMobile(req, res, (error) => (error ? next(error) : byIp(req, res, next)));
};

/**
 * Complete / update the profile after login.
 *   Required: name (Google accounts are complete without a mobile number).
 *   Optional: email; mobile (no OTP needed -> contact number; with otp + reqId -> verified login number)
 */
router.put('/me/profile', validate({ body: profileSchema }), limitOtpAttempts, async (req, res) =>
  ok(res, await completeProfile(req.user.id, req.body)),
);

router.patch('/me', validate({ body: updateMeSchema }), limitOtpAttempts, async (req, res) => {
  const user = await updateProfile(req.user.id, req.body);
  ok(res, { user: publicUser(user), profile: profileStatus(user) });
});

module.exports = router;
