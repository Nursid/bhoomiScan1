const { Router } = require('express');
const { z } = require('zod');
const { authenticate, requireRole } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { ok, created, paginationParams } = require('../../utils/response');
const usersService = require('./admin-users.service');
const adminsService = require('./admin-admins.service');
const paymentsService = require('./admin-payments.service');
const dashboardService = require('./admin-dashboard.service'); // ADDED
const landsService = require('./admin-lands.service'); // ADDED (land records)

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().trim().max(100).optional(),
  subscribed: z.enum(['true', 'false']).optional(),
  status: z.enum(['ACTIVE', 'BLOCKED']).optional(),
});
const idParamSchema = z.object({ id: z.string().uuid() });
const createAdminSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    email: z.string().trim().toLowerCase().email().max(200),
    phone: z.string().trim().min(10).max(20),
    password: z.string().min(8).max(200),
  })
  .strict();
const pagingQuery = {
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
};
const paymentsQuerySchema = z.object({
  ...pagingQuery,
  status: z.enum(['CREATED', 'SUCCESS', 'FAILED', 'REFUNDED']).optional(),
  search: z.string().trim().max(100).optional(),
});
const alertsQuerySchema = z.object({
  ...pagingQuery,
  type: z.enum(['PAYMENT_SUCCESS', 'PAYMENT_FAILED']).optional(),
});
const landsQuerySchema = z.object({
  ...pagingQuery,
  status: z.enum(['PENDING', 'VERIFIED', 'UNCHANGED', 'CHANGED', 'FAILED']).optional(),
  search: z.string().trim().max(100).optional(),
}); // ADDED (land records)

const router = Router();

router.use(authenticate, requireRole('ADMIN'));

router.get('/dashboard', async (req, res) => ok(res, await dashboardService.getOverview())); // ADDED

router.get('/users/summary', async (req, res) => ok(res, await usersService.getSummary()));

router.get('/users', validate({ query: listQuerySchema }), async (req, res) => {
  const { limit, page, skip } = paginationParams(req.query);
  const { search, status } = req.query;
  const subscribed = req.query.subscribed === undefined ? undefined : req.query.subscribed === 'true';
  const { users, meta } = await usersService.listUsers({ limit, page, skip, search, subscribed, status });
  ok(res, { users }, { meta });
});

router.get('/users/:id', validate({ params: idParamSchema }), async (req, res) => ok(res, await usersService.getUser(req.params.id)));

router.post('/admins', validate({ body: createAdminSchema }), async (req, res) => {
  created(res, { admin: await adminsService.createAdmin(req.body) });
});

router.get('/payments/summary', async (req, res) => ok(res, await paymentsService.getPaymentSummary()));

router.get('/payments', validate({ query: paymentsQuerySchema }), async (req, res) => {
  const { limit, page, skip } = paginationParams(req.query);
  const { payments, meta } = await paymentsService.listPayments({ limit, page, skip, status: req.query.status, search: req.query.search });
  ok(res, { payments }, { meta });
});

router.get('/alerts', validate({ query: alertsQuerySchema }), async (req, res) => {
  const { limit, page, skip } = paginationParams(req.query);
  const { alerts, meta } = await paymentsService.listPaymentAlerts({ limit, page, skip, type: req.query.type });
  ok(res, { alerts }, { meta });
});

// ADDED (land records) - keep /lands/summary ABOVE /lands
router.get('/lands/summary', async (req, res) => ok(res, await landsService.getLandSummary()));

router.get('/lands', validate({ query: landsQuerySchema }), async (req, res) => {
  const { limit, page, skip } = paginationParams(req.query);
  const { lands, meta } = await landsService.listLands({ limit, page, skip, status: req.query.status, search: req.query.search });
  ok(res, { lands }, { meta });
});

module.exports = router;