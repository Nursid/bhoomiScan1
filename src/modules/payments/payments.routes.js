/**
 *   POST /payments/create     auth   { subscriptionId }
 *   POST /payments/verify     auth   { razorpay_order_id, razorpay_payment_id, razorpay_signature }
 *   POST /payments/webhook    Razorpay (x-razorpay-signature over the raw body)
 *   GET  /payments            auth   history
 */

const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../../middleware/authenticate');
const validate = require('../../middleware/validate');
const controller = require('./payments.controller');

const createSchema = z.object({ subscriptionId: z.string().uuid('Invalid subscriptionId') }).strict();

const verifySchema = z
  .object({
    razorpay_order_id: z.string().trim().regex(/^order_[A-Za-z0-9]{6,40}$/, 'Invalid razorpay_order_id'),
    razorpay_payment_id: z.string().trim().regex(/^pay_[A-Za-z0-9]{6,40}$/, 'Invalid razorpay_payment_id'),
    razorpay_signature: z.string().trim().regex(/^[a-f0-9]{64}$/i, 'Invalid razorpay_signature'),
  })
  .strict();

const router = Router();

router.post('/webhook', controller.webhook);

router.use(authenticate);
router.get('/', controller.list);
router.post('/create', validate({ body: createSchema }), controller.create);
router.post('/verify', validate({ body: verifySchema }), controller.verify);

module.exports = router;
