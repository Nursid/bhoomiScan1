/**
 *   GET  /plans                          public
 *   POST /subscriptions/create           auth  { planCode }
 *   GET  /subscriptions                  auth  history
 *   GET  /subscriptions/current          auth  active + upcoming
 *   POST /subscriptions/:id/cancel       auth  (unpaid only)
 */

const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { ok, created } = require('../../utils/response');
const service = require('./subscriptions.service');

const createSchema = z
  .object({
    planCode: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9_-]{1,40}$/, 'Invalid plan code'),
  })
  .strict();

const idParams = z.object({ id: z.string().uuid('Invalid id') });

const plansRouter = Router();
plansRouter.get('/', async (req, res) => ok(res, { plans: await service.listPlans() }));

const subscriptionsRouter = Router();
subscriptionsRouter.use(authenticate);

subscriptionsRouter.post('/create', validate({ body: createSchema }), async (req, res) => {
  const result = await service.createSubscription(req.user.id, req.body.planCode);
  return result.reused ? ok(res, result) : created(res, result);
});

subscriptionsRouter.get('/', async (req, res) => ok(res, { subscriptions: await service.listSubscriptions(req.user.id) }));

subscriptionsRouter.get('/current', async (req, res) => ok(res, await service.getCurrent(req.user.id)));

subscriptionsRouter.post('/:id/cancel', validate({ params: idParams }), async (req, res) =>
  ok(res, { subscription: await service.cancelSubscription(req.user.id, req.params.id) }),
);

module.exports = { plansRouter, subscriptionsRouter };
