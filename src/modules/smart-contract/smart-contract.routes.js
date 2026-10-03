/**
 *   GET  /smart-contract/records?landVerificationId=   records of one parcel
 *   GET  /smart-contract/records/:id
 *   POST /smart-contract/records/:id/retry             failed records only
 */

const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const { ok } = require('../../utils/response');
const service = require('./smart-contract.service');

const idParams = z.object({ id: z.string().uuid('Invalid id') });

const router = Router();
router.use(authenticate);

router.get('/records', validate({ query: z.object({ landVerificationId: z.string().uuid('landVerificationId is required') }) }), async (req, res) =>
  ok(res, { records: await service.listForVerification(req.user.id, req.query.landVerificationId) }),
);

router.get('/records/:id', validate({ params: idParams }), async (req, res) => ok(res, { record: await service.getRecord(req.user.id, req.params.id) }));

router.post('/records/:id/retry', validate({ params: idParams }), async (req, res) =>
  ok(res, { record: await service.retryRecord(req.user.id, req.params.id) }),
);

module.exports = router;
