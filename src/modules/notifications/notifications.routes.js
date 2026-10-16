/**
 *   POST   /devices          auth  { token, platform: android|ios|web }   register / refresh an FCM token
 *   DELETE /devices          auth  { token }                              on logout
 *   GET    /notifications    auth  ?page=&limit=                          inbox (every push, newest first)
 */

const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { ok, created, paginationParams, paginationMeta } = require('../../utils/response');
const service = require('./notifications.service');

// FCM registration tokens are long opaque strings without whitespace.
const token = z.string().trim().min(20, 'Invalid token').max(4096, 'Invalid token').regex(/^\S+$/, 'Invalid token');

const registerSchema = z
  .object({
    token,
    platform: z
      .string()
      .trim()
      .toUpperCase()
      .pipe(z.enum(['ANDROID', 'IOS', 'WEB'])),
  })
  .strict();

const removeSchema = z.object({ token }).strict();

const pageQuery = z.object({ page: z.string().regex(/^\d+$/).optional(), limit: z.string().regex(/^\d+$/).optional() });

const devicesRouter = Router();
devicesRouter.use(authenticate);
devicesRouter.post('/', validate({ body: registerSchema }), async (req, res) => created(res, { device: await service.registerDevice(req.user.id, req.body) }));
devicesRouter.delete('/', validate({ body: removeSchema }), async (req, res) => ok(res, await service.removeDevice(req.user.id, req.body.token)));

const notificationsRouter = Router();
notificationsRouter.use(authenticate);
notificationsRouter.get('/', validate({ query: pageQuery }), async (req, res) => {
  const pagination = paginationParams(req.query);
  const { notifications, total } = await service.listNotifications(req.user.id, pagination);
  ok(res, { notifications }, { meta: paginationMeta(pagination, total) });
});

module.exports = { devicesRouter, notificationsRouter };
