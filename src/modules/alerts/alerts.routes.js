/**
 *   GET   /alerts?status=UNREAD&landVerificationId=&page=&limit=
 *   PATCH /alerts/:id/read
 *   POST  /alerts/read-all
 */

const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { ok, paginationParams, paginationMeta } = require('../../utils/response');
const service = require('./alerts.service');

const listQuery = z.object({
  status: z.enum(['UNREAD', 'READ']).optional(),
  landVerificationId: z.string().uuid().optional(),
  page: z.string().regex(/^\d+$/).optional(),
  limit: z.string().regex(/^\d+$/).optional(),
});

const router = Router();
router.use(authenticate);

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const pagination = paginationParams(req.query);
  const { alerts, total, unread } = await service.listAlerts(req.user.id, { ...req.query, ...pagination });
  ok(res, { alerts, unread }, { meta: paginationMeta(pagination, total) });
});

router.patch('/:id/read', validate({ params: z.object({ id: z.string().uuid() }) }), async (req, res) =>
  ok(res, { alert: await service.markRead(req.user.id, req.params.id) }),
);

router.post('/read-all', async (req, res) => ok(res, await service.markAllRead(req.user.id)));

module.exports = router;
