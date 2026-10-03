const { createHmac } = require('crypto');
const { prisma, resetDb, installFetch, api, login, settle } = require('./helpers');

const KEY_SECRET = 'rzp-integration-secret';
const WEBHOOK_SECRET = 'rzp-integration-webhook-secret';
const RZP = /^https:\/\/api\.razorpay\.test/;

const checkoutSignature = (orderId, paymentId) => createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
const webhookSignature = (raw) => createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

let fake;
let orderSeq = 0;

const nextOrderId = () => {
  orderSeq += 1;
  return `order_TEST${String(orderSeq).padStart(8, '0')}`;
};

beforeAll(async () => {
  await resetDb();
  fake = installFetch();
  fake.on('POST', new RegExp(`${RZP.source}/v1/orders$`), (url, init, body) => ({
    body: { id: nextOrderId(), entity: 'order', amount: body.amount, currency: body.currency, receipt: body.receipt, status: 'created' },
  }));
});

afterAll(async () => {
  fake.restore();
  await settle();
  await prisma.$disconnect();
});

const sendWebhook = (app, payload, { eventId, signature } = {}) => {
  const raw = JSON.stringify(payload);
  return app
    .post('/api/v1/payments/webhook')
    .set('content-type', 'application/json')
    .set('x-razorpay-signature', signature || webhookSignature(raw))
    .set('x-razorpay-event-id', eventId || `evt_${Math.random().toString(36).slice(2)}`)
    .send(raw);
};

describe('auth', () => {
  test('send-otp, verify-otp, /users/me; wrong OTP and bad tokens are rejected', async () => {
    const app = api();
    const sent = await app.post('/api/v1/auth/send-otp').send({ mobile: '9876543210' });
    expect(sent.status).toBe(200);
    expect(sent.body.data.mobile).toBe('+919876543210');

    const wrong = await app.post('/api/v1/auth/verify-otp').send({ mobile: '9876543210', otp: '000000' });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe('INVALID_OTP');

    const { auth, user } = await login(app, '9876543210');
    expect(user.mobile).toBe('+919876543210');
    const again = await login(app, '+91 98765 43210');
    expect(again.user.id).toBe(user.id); // same user on second login

    const me = await app.get('/api/v1/users/me').set(auth);
    expect(me.status).toBe(200);
    expect(me.body.data.activeSubscription).toBeNull();

    expect((await app.get('/api/v1/users/me')).status).toBe(401);
    expect((await app.get('/api/v1/users/me').set({ Authorization: 'Bearer nope' })).body.error.code).toBe('INVALID_TOKEN');
  });

  test('validation errors are 422 with field details', async () => {
    const res = await api().post('/api/v1/auth/verify-otp').send({ mobile: '12', otp: 'abc' });
    expect(res.status).toBe(422);
    expect(res.body.error.details.map((d) => d.field).sort()).toEqual(['mobile', 'otp']);
  });
});

describe('plans, subscriptions and payments', () => {
  let app;
  let auth;
  let userId;

  beforeAll(async () => {
    app = api();
    ({ auth, user: { id: userId } } = await login(app, '9123456780'));
  });

  test('GET /plans is public', async () => {
    const res = await app.get('/api/v1/plans');
    expect(res.status).toBe(200);
    expect(res.body.data.plans.map((p) => p.code)).toEqual(['monthly', 'quarterly']);
  });

  test('paid land features are blocked without an active subscription', async () => {
    const res = await app.get('/api/v1/land-verification/punjab/districts').set(auth);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  let monthlyOrderId;
  test('create subscription -> create payment -> verify activates only after backend checks', async () => {
    const sub = await app.post('/api/v1/subscriptions/create').set(auth).send({ planCode: 'monthly' });
    expect(sub.status).toBe(201);
    expect(sub.body.data.subscription.status).toBe('PENDING');
    const subscriptionId = sub.body.data.subscription.id;

    const reused = await app.post('/api/v1/subscriptions/create').set(auth).send({ planCode: 'MONTHLY' });
    expect(reused.status).toBe(200);
    expect(reused.body.data.subscription.id).toBe(subscriptionId);

    const pay = await app.post('/api/v1/payments/create').set(auth).send({ subscriptionId });
    expect(pay.status).toBe(201);
    expect(pay.body.data.checkout).toMatchObject({ keyId: 'rzp_test_integration', amount: 59100, currency: 'INR' });
    monthlyOrderId = pay.body.data.checkout.orderId;
    const orderCall = fake.callsTo(/\/v1\/orders$/).pop();
    expect(orderCall.body).toMatchObject({ amount: 59100, currency: 'INR', notes: { subscriptionId } });
    expect(orderCall.headers.authorization).toMatch(/^Basic /);

    const paymentId = 'pay_TEST00000001';
    const tampered = await app
      .post('/api/v1/payments/verify')
      .set(auth)
      .send({ razorpay_order_id: monthlyOrderId, razorpay_payment_id: paymentId, razorpay_signature: 'a'.repeat(64) });
    expect(tampered.status).toBe(400);
    expect(tampered.body.error.code).toBe('INVALID_PAYMENT_SIGNATURE');

    fake.on('GET', new RegExp(`/v1/payments/${paymentId}$`), {
      body: { id: paymentId, entity: 'payment', order_id: monthlyOrderId, amount: 59100, currency: 'INR', status: 'captured', method: 'upi', created_at: Math.floor(Date.now() / 1000) },
    });
    const body = { razorpay_order_id: monthlyOrderId, razorpay_payment_id: paymentId, razorpay_signature: checkoutSignature(monthlyOrderId, paymentId) };
    const verified = await app.post('/api/v1/payments/verify').set(auth).send(body);
    expect(verified.status).toBe(200);
    expect(verified.body.data.payment.status).toBe('SUCCESS');
    expect(verified.body.data.subscription).toMatchObject({ status: 'ACTIVE', isCurrent: true });

    const twice = await app.post('/api/v1/payments/verify').set(auth).send(body);
    expect(twice.body.data.alreadyProcessed).toBe(true);

    const current = await app.get('/api/v1/subscriptions/current').set(auth);
    expect(current.body.data.active.id).toBe(subscriptionId);
  });

  let quarterlyOrderId;
  let quarterlySubscriptionId;
  test('amount mismatch reported by Razorpay is rejected', async () => {
    const sub = await app.post('/api/v1/subscriptions/create').set(auth).send({ planCode: 'quarterly' });
    quarterlySubscriptionId = sub.body.data.subscription.id;
    const pay = await app.post('/api/v1/payments/create').set(auth).send({ subscriptionId: quarterlySubscriptionId });
    quarterlyOrderId = pay.body.data.checkout.orderId;

    const paymentId = 'pay_TEST00000002';
    fake.on('GET', new RegExp(`/v1/payments/${paymentId}$`), {
      body: { id: paymentId, order_id: quarterlyOrderId, amount: 100, currency: 'INR', status: 'captured' },
    });
    const res = await app
      .post('/api/v1/payments/verify')
      .set(auth)
      .send({ razorpay_order_id: quarterlyOrderId, razorpay_payment_id: paymentId, razorpay_signature: checkoutSignature(quarterlyOrderId, paymentId) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('PAYMENT_MISMATCH');
    const sub2 = await prisma.subscription.findUnique({ where: { id: quarterlySubscriptionId } });
    expect(sub2.status).toBe('PENDING');
  });

  test('webhook: bad signature 401; payment.captured activates and stacks after the current period; duplicates ignored', async () => {
    const payload = {
      event: 'payment.captured',
      created_at: Math.floor(Date.now() / 1000),
      payload: { payment: { entity: { id: 'pay_TEST00000003', order_id: quarterlyOrderId, amount: 159900, currency: 'INR', status: 'captured', method: 'card' } } },
    };
    const bad = await sendWebhook(app, payload, { signature: 'f'.repeat(64) });
    expect(bad.status).toBe(401);

    const ok = await sendWebhook(app, payload, { eventId: 'evt_capture_1' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.result).toBe('activated');

    const monthly = await prisma.subscription.findFirst({ where: { userId, plan: { code: 'monthly' } } });
    const quarterly = await prisma.subscription.findUnique({ where: { id: quarterlySubscriptionId } });
    expect(quarterly.status).toBe('ACTIVE');
    expect(quarterly.startsAt.toISOString()).toBe(monthly.endsAt.toISOString());

    const dup = await sendWebhook(app, payload, { eventId: 'evt_capture_1' });
    expect(dup.body.data.duplicate).toBe(true);
  });

  test('webhook: payment.failed marks payment and subscription FAILED; refund cancels', async () => {
    const other = await login(app, '9000000001');
    const sub = await app.post('/api/v1/subscriptions/create').set(other.auth).send({ planCode: 'monthly' });
    const pay = await app.post('/api/v1/payments/create').set(other.auth).send({ subscriptionId: sub.body.data.subscription.id });
    const orderId = pay.body.data.checkout.orderId;

    const failed = await sendWebhook(app, {
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_TEST00000004', order_id: orderId, amount: 59100, currency: 'INR', status: 'failed', error_code: 'BAD_REQUEST_ERROR', error_description: 'Card declined' } } },
    });
    expect(failed.body.data.result).toBe('marked_failed');
    expect((await prisma.subscription.findUnique({ where: { id: sub.body.data.subscription.id } })).status).toBe('FAILED');

    // Retry on the same order succeeds later via webhook.
    const captured = await sendWebhook(app, {
      event: 'order.paid',
      payload: { payment: { entity: { id: 'pay_TEST00000005', order_id: orderId, amount: 59100, currency: 'INR', status: 'captured' } } },
    });
    expect(captured.body.data.result).toBe('activated');

    const refunded = await sendWebhook(app, {
      event: 'refund.processed',
      payload: {
        refund: { entity: { id: 'rfnd_1', payment_id: 'pay_TEST00000005', amount: 59100 } },
        payment: { entity: { id: 'pay_TEST00000005', amount: 59100, amount_refunded: 59100 } },
      },
    });
    expect(refunded.body.data.result).toBe('refunded');
    const payment = await prisma.payment.findUnique({ where: { providerPaymentId: 'pay_TEST00000005' } });
    expect(payment.status).toBe('REFUNDED');
    expect((await prisma.subscription.findUnique({ where: { id: payment.subscriptionId } })).status).toBe('CANCELLED');

    const history = await app.get('/api/v1/payments').set(other.auth);
    expect(history.body.data.payments).toHaveLength(1);
  });

  test('a user cannot pay for someone else\'s subscription', async () => {
    const other = await login(app, '9000000002');
    const subscription = await prisma.subscription.findFirst({ where: { userId } });
    const res = await app.post('/api/v1/payments/create').set(other.auth).send({ subscriptionId: subscription.id });
    expect(res.status).toBe(404);
  });
});
