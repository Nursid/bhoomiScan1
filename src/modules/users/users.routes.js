const { Router } = require('express');
const { z } = require('zod');
const { prisma } = require('../../database/prisma');
const { authenticate } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { ok } = require('../../utils/response');
const { publicUser } = require('../auth/auth.service');
const subscriptionsService = require('../subscriptions/subscriptions.service');

const updateMeSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    email: z.string().trim().toLowerCase().email().max(200).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'No updatable fields provided');

const router = Router();

router.use(authenticate);

router.get('/me', async (req, res) => {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: req.user.id } });
  const subscription = await subscriptionsService.findActiveSubscription(user.id);
  ok(res, { user: publicUser(user), activeSubscription: subscription ? subscriptionsService.publicSubscription(subscription) : null });
});

router.patch('/me', validate({ body: updateMeSchema }), async (req, res) => {
  const user = await prisma.user.update({ where: { id: req.user.id }, data: req.body });
  ok(res, { user: publicUser(user) });
});

module.exports = router;
