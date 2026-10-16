// POST /api/v1/payments/callback: Razorpay Checkout redirect mode posts the result as a form.
const { createHmac } = require('crypto');
const { prisma, resetDb, installFetch, api, login, settle } = require('./helpers');

const KEY_SECRET = 'rzp-integration-secret';
const RZP = /^https:\/\/api\.razorpay\.test/;
const signature = (orderId, paymentId) => createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

let fake;
let orderSeq = 0;

beforeAll(async () => {
  await resetDb();
  fake = installFetch();
  fake.on('POST', new RegExp(`${RZP.source}/v1/orders$`), (url, init, body) => {
    orderSeq += 1;
    return { body: { id: `order_CB${String(orderSeq).padStart(8, '0')}`, amount: body.amount, currency: body.currency, status: 'created' } };
  });
});

afterAll(async () => {
  fake.restore();
  await settle();
  await prisma.$disconnect();
});

const startPayment = async (app, mobile, planCode = 'monthly') => {
  const { auth } = await login(app, mobile);
  const sub = await app.post('/api/v1/subscriptions/create').set(auth).send({ planCode });
  const pay = await app.post('/api/v1/payments/create').set(auth).send({ subscriptionId: sub.body.data.subscription.id });
  return { auth, subscriptionId: sub.body.data.subscription.id, orderId: pay.body.data.checkout.orderId, amount: pay.body.data.checkout.amount };
};

const postForm = (app, fields) => app.post('/api/v1/payments/callback').type('form').send(fields);

const location = (res) => new URL(res.headers.location, 'http://x');

describe('POST /api/v1/payments/callback', () => {
  test('authorized payment from a redirect is captured, subscription activated, browser sent back to /payment', async () => {
    const app = api();
    const { subscriptionId, orderId, amount } = await startPayment(app, '9000000001');
    const paymentId = 'pay_CALLBACK0001';
    fake.on('GET', new RegExp(`/v1/payments/${paymentId}$`), {
      body: { id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'authorized' },
    });
    fake.on('POST', new RegExp(`/v1/payments/${paymentId}/capture$`), {
      body: { id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured', created_at: Math.floor(Date.now() / 1000) },
    });

    const res = await postForm(app, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature(orderId, paymentId) });
    expect(res.status).toBe(303);
    const target = location(res);
    expect(target.pathname).toBe('/payment');
    expect(Object.fromEntries(target.searchParams)).toEqual({ status: 'success', paymentId, subscriptionId });
    expect(fake.callsTo(new RegExp(`/v1/payments/${paymentId}/capture$`))).toHaveLength(1);
    expect((await prisma.subscription.findUnique({ where: { id: subscriptionId } })).status).toBe('ACTIVE');
    expect((await prisma.payment.findFirst({ where: { providerOrderId: orderId } })).status).toBe('SUCCESS');

    // Replayed post (browser back/refresh) is idempotent.
    const again = await postForm(app, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature(orderId, paymentId) });
    expect(location(again).searchParams.get('status')).toBe('success');
  });

  test('forged signature does not activate anything', async () => {
    const app = api();
    const { subscriptionId, orderId } = await startPayment(app, '9000000002');
    const res = await postForm(app, { razorpay_order_id: orderId, razorpay_payment_id: 'pay_FORGED00001', razorpay_signature: 'a'.repeat(64) });
    expect(res.status).toBe(303);
    expect(Object.fromEntries(location(res).searchParams)).toMatchObject({ status: 'failed', reason: 'Invalid payment signature' });
    expect((await prisma.subscription.findUnique({ where: { id: subscriptionId } })).status).toBe('PENDING');
  });

  test('Razorpay failure post and malformed fields -> failed, without calling Razorpay', async () => {
    const app = api();
    const before = fake.calls.length;
    const failed = await postForm(app, { 'error[code]': 'BAD_REQUEST_ERROR', 'error[description]': 'Payment was cancelled by user' });
    expect(Object.fromEntries(location(failed).searchParams)).toEqual({ status: 'failed', reason: 'Payment was cancelled by user' });
    const junk = await postForm(app, { razorpay_order_id: 'x', razorpay_payment_id: 'y', razorpay_signature: 'z' });
    expect(Object.fromEntries(location(junk).searchParams)).toEqual({ status: 'failed', reason: 'Invalid payment response' });
    expect(fake.calls.length).toBe(before);
  });

  test('Razorpay outage -> pending (the webhook can still confirm it)', async () => {
    const app = api();
    const { subscriptionId, orderId } = await startPayment(app, '9000000003');
    const paymentId = 'pay_OUTAGE000001';
    fake.on('GET', new RegExp(`/v1/payments/${paymentId}$`), { status: 503, body: { error: { description: 'down' } } });
    const res = await postForm(app, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature(orderId, paymentId) });
    expect(Object.fromEntries(location(res).searchParams)).toMatchObject({ status: 'pending', paymentId });
    expect((await prisma.subscription.findUnique({ where: { id: subscriptionId } })).status).toBe('PENDING');
  });
});
