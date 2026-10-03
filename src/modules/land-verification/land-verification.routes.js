/**
 * All routes require authentication. Provider-backed routes (metadata + verify)
 * and enabling monitoring also require an ACTIVE subscription; reading your own
 * stored history does not (it stays available after a subscription ends).
 *
 *   GET  /states
 *   GET  /:state/districts
 *   POST /:state/tehsils      { district }
 *   POST /:state/villages     { district, tehsil }
 *   POST /:state/years        { district, tehsil, village }
 *   POST /:state/khasras      { district, tehsil, village, year }
 *   POST /:state/verify       { district, tehsil, village, year, khasra_number }
 *   GET  /                    my parcels
 *   GET  /:id
 *   GET  /:id/history
 *   GET  /:id/history/:snapshotId
 *   GET  /:id/changes?snapshotId=&critical=true
 *   PUT  /:id/monitoring      { enabled, frequency: WEEKLY|MONTHLY|QUARTERLY }
 */

const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../../middleware/authenticate');
const requireActiveSubscription = require('../../middleware/requireActiveSubscription');
const validate = require('../../middleware/validate');
const { landVerifyLimiter } = require('../../middleware/rateLimiters');
const { FREQUENCIES } = require('./verification-schedule');
const controller = require('./land-verification.controller');

const stateParams = z.object({ state: z.string().trim().toLowerCase().regex(/^[a-z-]{2,40}$/, 'Invalid state') });
const idParams = z.object({ id: z.string().uuid('Invalid id') });
const snapshotParams = idParams.extend({ snapshotId: z.string().uuid('Invalid snapshotId') });
const pageQuery = z.object({ page: z.string().regex(/^\d+$/).optional(), limit: z.string().regex(/^\d+$/).optional() });
const changesQuery = pageQuery.extend({ snapshotId: z.string().uuid().optional(), critical: z.enum(['true', 'false']).optional() });

const monitoringSchema = z
  .object({
    enabled: z.boolean(),
    frequency: z.enum(FREQUENCIES).optional(),
  })
  .strict()
  .refine((value) => !value.enabled || value.frequency, { message: 'frequency is required when enabling monitoring', path: ['frequency'] });

const router = Router();
router.use(authenticate);

router.get('/states', controller.states);

const paid = [validate({ params: stateParams }), requireActiveSubscription];
router.get('/:state/districts', ...paid, controller.metadata('districts'));
router.post('/:state/tehsils', ...paid, controller.metadata('tehsils'));
router.post('/:state/villages', ...paid, controller.metadata('villages'));
router.post('/:state/years', ...paid, controller.metadata('years'));
router.post('/:state/khasras', ...paid, controller.metadata('khasras'));
router.post('/:state/verify', ...paid, landVerifyLimiter, controller.verify);

router.get('/', validate({ query: pageQuery }), controller.list);
router.get('/:id', validate({ params: idParams }), controller.get);
router.get('/:id/history', validate({ params: idParams, query: pageQuery }), controller.history);
router.get('/:id/history/:snapshotId', validate({ params: snapshotParams }), controller.snapshot);
router.get('/:id/changes', validate({ params: idParams, query: changesQuery }), controller.changes);
// Turning monitoring off never requires a subscription.
const subscriptionToEnable = (req, res, next) => (req.body.enabled ? requireActiveSubscription(req, res, next) : next());
router.put('/:id/monitoring', validate({ params: idParams, body: monitoringSchema }), subscriptionToEnable, controller.monitoring);

module.exports = router;
