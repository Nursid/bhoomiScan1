const service = require('./payments.service');
const { ok, created } = require('../../utils/response');

const create = async (req, res) => created(res, await service.createPayment(req.user.id, req.body.subscriptionId));

const verify = async (req, res) => ok(res, await service.verifyPayment(req.user.id, req.body));

// Razorpay Checkout redirect mode (bank / 3-D Secure pages, blocked popups, mobile) posts the
// result here as a form instead of calling the page's handler. Verify exactly like /verify,
// then send the browser back to the payment page with the outcome.
const CALLBACK_FIELDS = /^(order|pay)_[A-Za-z0-9]{6,40}$/;

const callbackRedirect = (res, params) => res.redirect(303, `/payment?${new URLSearchParams(params)}`);

const callback = async (req, res) => {
  const body = req.body || {};
  const orderId = String(body.razorpay_order_id || '');
  const paymentId = String(body.razorpay_payment_id || '');
  const signature = String(body.razorpay_signature || '');

  if (!orderId && !paymentId && body['error[description]']) {
    return callbackRedirect(res, { status: 'failed', reason: String(body['error[description]']).slice(0, 200) });
  }
  if (!CALLBACK_FIELDS.test(orderId) || !CALLBACK_FIELDS.test(paymentId) || !/^[a-f0-9]{64}$/i.test(signature)) {
    return callbackRedirect(res, { status: 'failed', reason: 'Invalid payment response' });
  }
  try {
    const result = await service.verifyPayment(null, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature });
    return callbackRedirect(res, { status: 'success', paymentId, subscriptionId: result.subscription.id });
  } catch (error) {
    req.log?.warn({ code: error.code, orderId }, 'payment callback verification failed');
    // 4xx = definite rejection (bad signature, failed payment). Anything else may still
    // succeed via the webhook, so the user is told it is pending, not failed.
    const rejected = error.statusCode >= 400 && error.statusCode < 500 && error.code !== 'PAYMENT_NOT_CAPTURED';
    return callbackRedirect(res, {
      status: rejected ? 'failed' : 'pending',
      reason: rejected ? error.message : 'Payment received; confirmation is pending',
      paymentId,
    });
  }
};

// Razorpay only needs a 2xx; failures return non-2xx so Razorpay retries.
const webhook = async (req, res) => ok(res, await service.handleWebhook(req.rawBody, req.headers, req.body));

const list = async (req, res) => ok(res, { payments: await service.listPayments(req.user.id) });

module.exports = { create, verify, callback, webhook, list };
