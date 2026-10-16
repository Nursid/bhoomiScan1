// Annual plan purchase, status, expiry and manual renewal, end to end through the API.
// Time is controlled with test data (moving periods) and the service's injectable dates,
// never by waiting.
const { createHmac } = require('crypto');
const { prisma, resetDb, installFetch, api, login, settle } = require('./helpers');
const subscriptions = require('../../src/modules/subscriptions/subscriptions.service');
const config = require('../../src/config');

const KEY_SECRET = 'rzp-integration-secret';
const WEBHOOK_SECRET = 'rzp-integration-webhook-secret';
const RZP = /^https:\/\/api\.razorpay\.test/;
const DAY = 86400000;
const WINDOW = config.subscriptions.renewalWindowDays;

const checkoutSignature = (orderId, paymentId) => createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');

let fake;
let app;
let seq = 0;
const next = (prefix) => `${prefix}${String((seq += 1)).padStart(10, '0')}`;

beforeAll(async () => {
  await resetDb();
  await prisma.subscriptionPlan.create({
    data: { code: 'annual', name: 'Annual', amount: 99900, currency: 'INR', interval: 'YEARLY', durationMonths: 12, allowedFrequencies: ['MONTHLY'], maxMonitoredLands: 5, sortOrder: 0 },
  });
  fake = installFetch();
  fake.on('POST', new RegExp(`${RZP.source}/v1/orders$`), (url, init, body) => ({
    body: { id: next('order_RN'), amount: body.amount, currency: body.currency, status: 'created' },
  }));
  app = api();
});

afterAll(async () => {
  fake.restore();
  await settle();
  await prisma.$disconnect();
});

const webhook = (entity, eventId = next('evt_')) => {
  const raw = JSON.stringify({ event: entity.status === 'failed' ? 'payment.failed' : 'payment.captured', payload: { payment: { entity } } });
  return app
    .post('/api/v1/payments/webhook')
    .set('content-type', 'application/json')
    .set('x-razorpay-signature', createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'))
    .set('x-razorpay-event-id', eventId)
    .send(raw);
};

/** create/renew -> order -> captured webhook. Returns ids and the HTTP results. */
const buy = async (auth, { path = '/api/v1/subscriptions/create', body = { planCode: 'annual' } } = {}) => {
  const sub = await app.post(path).set(auth).send(body);
  if (sub.status >= 300) return { sub };
  const subscriptionId = sub.body.data.subscription.id;
  const pay = await app.post('/api/v1/payments/create').set(auth).send({ subscriptionId });
  const { orderId, amount } = pay.body.data.checkout;
  const paymentId = next('pay_RN');
  const captured = await webhook({ id: paymentId, order_id: orderId, amount, currency: 'INR', status: 'captured', created_at: Math.floor(Date.now() / 1000) });
  return { sub, subscriptionId, orderId, paymentId, amount, captured };
};

const current = async (auth) => (await app.get('/api/v1/subscriptions/current').set(auth)).body.data;
const hasAccess = async (auth) => (await app.get('/api/v1/land-verification/punjab/districts').set(auth)).body?.error?.code !== 'SUBSCRIPTION_REQUIRED';

/** Shift a user's paid periods so the last one ends `daysFromNow` days from now (negative = expired). */
const moveLastPeriodEnd = async (userId, daysFromNow) => {
  const periods = await prisma.subscription.findMany({ where: { userId, activatedAt: { not: null } }, orderBy: { endsAt: 'desc' } });
  const shift = Date.now() + daysFromNow * DAY - periods[0].endsAt.getTime();
  for (const period of periods) {
    await prisma.subscription.update({
      where: { id: period.id },
      data: { startsAt: new Date(period.startsAt.getTime() + shift), endsAt: new Date(period.endsAt.getTime() + shift) },
    });
  }
};

describe('first purchase and active state', () => {
  test('purchase activates a 12-calendar-month period; app shows ACTIVE without asking to buy again', async () => {
    const { auth, user } = await login(app, '9100000001');
    expect(await current(auth)).toMatchObject({ status: 'NONE', active: null, latest: null, renewal: { allowed: true } });

    const { captured, subscriptionId } = await buy(auth);
    expect(captured.body.data.result).toBe('activated');

    const state = await current(auth);
    expect(state.status).toBe('ACTIVE');
    expect(state.active).toMatchObject({ id: subscriptionId, status: 'ACTIVE', isCurrent: true, plan: { code: 'annual', durationMonths: 12 } });
    const startsAt = new Date(state.active.startsAt);
    const endsAt = new Date(state.active.endsAt);
    expect(endsAt.getUTCFullYear()).toBe(startsAt.getUTCFullYear() + 1);
    expect(endsAt.getUTCMonth()).toBe(startsAt.getUTCMonth());
    expect(state.renewal).toMatchObject({ allowed: false, reason: 'SUBSCRIPTION_ALREADY_ACTIVE', planCode: 'annual', windowDays: WINDOW });
    expect(new Date(state.renewal.renewableFrom).getTime()).toBe(endsAt.getTime() - WINDOW * DAY);
    expect(await hasAccess(auth)).toBe(true);

    // Buying or renewing again mid-year is refused; nothing new is created.
    for (const [path, body] of [['/api/v1/subscriptions/create', { planCode: 'annual' }], ['/api/v1/subscriptions/renew', {}]]) {
      const res = await app.post(path).set(auth).send(body);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({ code: 'SUBSCRIPTION_ALREADY_ACTIVE', details: { paidUntil: state.active.endsAt } });
    }
    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(1);

    // Logging out and back in (new token) shows the same plan.
    const again = await login(app, '9100000001');
    expect((await current(again.auth)).active.id).toBe(subscriptionId);
  });

  test('a yearly period from 29 Feb ends on 28 Feb (calendar months, not 365 days)', async () => {
    const { user } = await login(app, '9100000002');
    const plan = await prisma.subscriptionPlan.findUnique({ where: { code: 'annual' } });
    const pending = await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, amount: plan.amount, currency: 'INR' } });
    const activated = await prisma.$transaction((tx) => subscriptions.activateSubscription(tx, pending.id, new Date('2028-02-29T10:00:00Z')));
    expect(activated.startsAt.toISOString()).toBe('2028-02-29T10:00:00.000Z');
    expect(activated.endsAt.toISOString()).toBe('2029-02-28T10:00:00.000Z');
  });

  test('pending payment is shown as PENDING and grants no access', async () => {
    const { auth } = await login(app, '9100000003');
    await app.post('/api/v1/subscriptions/create').set(auth).send({ planCode: 'annual' });
    const state = await current(auth);
    expect(state).toMatchObject({ status: 'PENDING', active: null, pending: { status: 'PENDING', plan: { code: 'annual' } } });
    expect(await hasAccess(auth)).toBe(false);
  });
});

describe('renewal', () => {
  test('renewal before expiry (inside the window) starts when the current year ends; no days lost; no third purchase', async () => {
    const { auth, user } = await login(app, '9100000010');
    await buy(auth);
    await moveLastPeriodEnd(user.id, 10);
    const before = await current(auth);
    expect(before.renewal).toMatchObject({ allowed: true, reason: 'RENEWAL_DUE' });

    const { captured, subscriptionId, sub } = await buy(auth, { path: '/api/v1/subscriptions/renew', body: {} });
    expect(sub.body.data.subscription.plan.code).toBe('annual'); // same plan by default
    expect(captured.body.data.result).toBe('activated');

    const renewed = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
    expect(renewed.startsAt.toISOString()).toBe(before.active.endsAt);
    expect(renewed.endsAt.getUTCFullYear()).toBe(renewed.startsAt.getUTCFullYear() + 1);

    const after = await current(auth);
    expect(after.active.id).toBe(before.active.id); // current year unchanged
    expect(after.upcoming.map((s) => s.id)).toEqual([subscriptionId]);
    expect(after.renewal).toMatchObject({ allowed: false, paidUntil: renewed.endsAt.toISOString() });
    expect((await app.post('/api/v1/subscriptions/renew').set(auth).send({})).status).toBe(409);
  });

  test('after expiry: EXPIRED status, no access, Renew restores access from the payment date', async () => {
    const { auth, user } = await login(app, '9100000011');
    const first = await buy(auth);
    await moveLastPeriodEnd(user.id, -3);

    // Access ends at endsAt even before the expiry job runs.
    expect(await hasAccess(auth)).toBe(false);
    let state = await current(auth);
    expect(state).toMatchObject({ status: 'EXPIRED', active: null, latest: { id: first.subscriptionId }, renewal: { allowed: true, planCode: 'annual' } });

    await subscriptions.expireDueSubscriptions();
    state = await current(auth);
    expect(state).toMatchObject({ status: 'EXPIRED', latest: { id: first.subscriptionId, status: 'EXPIRED' } });

    const paidAt = Date.now();
    const { subscriptionId } = await buy(auth, { path: '/api/v1/subscriptions/renew', body: {} });
    state = await current(auth);
    expect(state.status).toBe('ACTIVE');
    expect(state.active.id).toBe(subscriptionId);
    expect(Math.abs(new Date(state.active.startsAt).getTime() - paidAt)).toBeLessThan(60000);
    expect(await hasAccess(auth)).toBe(true);
    // Renewal history: one row per paid period.
    const history = (await app.get('/api/v1/subscriptions').set(auth)).body.data.subscriptions;
    expect(history.map((s) => s.status).sort()).toEqual(['ACTIVE', 'EXPIRED']);
  });

  test('renew can change plan; retired previous plan or no history must choose a plan', async () => {
    const { auth, user } = await login(app, '9100000012');
    expect((await app.post('/api/v1/subscriptions/renew').set(auth).send({})).body.error.code).toBe('NOTHING_TO_RENEW');

    await buy(auth);
    await moveLastPeriodEnd(user.id, -1);
    const changed = await app.post('/api/v1/subscriptions/renew').set(auth).send({ planCode: 'monthly' });
    expect(changed.status).toBe(201);
    expect(changed.body.data.subscription.plan.code).toBe('monthly');

    await prisma.subscriptionPlan.update({ where: { code: 'annual' }, data: { isActive: false } });
    try {
      const retired = await app.post('/api/v1/subscriptions/renew').set(auth).send({});
      expect(retired.status).toBe(409);
      expect(retired.body.error.code).toBe('PLAN_UNAVAILABLE');
      expect((await current(auth)).renewal.planCode).toBeNull();
    } finally {
      await prisma.subscriptionPlan.update({ where: { code: 'annual' }, data: { isActive: true } });
    }
  });
});

describe('payment safety', () => {
  test('failed renewal payment neither activates nor extends anything', async () => {
    const { auth, user } = await login(app, '9100000020');
    await buy(auth);
    await moveLastPeriodEnd(user.id, 5);
    const before = await current(auth);

    const sub = await app.post('/api/v1/subscriptions/renew').set(auth).send({});
    const pay = await app.post('/api/v1/payments/create').set(auth).send({ subscriptionId: sub.body.data.subscription.id });
    const res = await webhook({ id: next('pay_FL'), order_id: pay.body.data.checkout.orderId, amount: pay.body.data.checkout.amount, currency: 'INR', status: 'failed', error_code: 'BAD_REQUEST_ERROR' });
    expect(res.body.data.result).toBe('marked_failed');

    const after = await current(auth);
    expect(after.renewal.paidUntil).toBe(before.renewal.paidUntil);
    expect(after.upcoming).toEqual([]);
  });

  test('double tap on Pay reuses the unpaid order; verify + callback + webhook give exactly one period', async () => {
    const { auth } = await login(app, '9100000021');
    const sub = await app.post('/api/v1/subscriptions/create').set(auth).send({ planCode: 'annual' });
    const subscriptionId = sub.body.data.subscription.id;
    const ordersBefore = fake.callsTo(/\/v1\/orders$/).length;
    const [a, b] = await Promise.all([1, 2].map(() => app.post('/api/v1/payments/create').set(auth).send({ subscriptionId })));
    const third = await app.post('/api/v1/payments/create').set(auth).send({ subscriptionId });
    const orderIds = new Set([a, b, third].map((r) => r.body.data.checkout.orderId));
    // Concurrent taps may both reach Razorpay once; after that the open order is reused.
    expect(third.body.data.reused).toBe(true);
    expect(orderIds.has(third.body.data.checkout.orderId)).toBe(true);
    expect(fake.callsTo(/\/v1\/orders$/).length - ordersBefore).toBeLessThanOrEqual(2);

    const orderId = third.body.data.checkout.orderId;
    const paymentId = next('pay_DU');
    const entity = { id: paymentId, order_id: orderId, amount: 99900, currency: 'INR', status: 'captured', created_at: Math.floor(Date.now() / 1000) };
    fake.on('GET', new RegExp(`/v1/payments/${paymentId}$`), { body: entity });
    const body = { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: checkoutSignature(orderId, paymentId) };

    const results = await Promise.all([
      app.post('/api/v1/payments/verify').set(auth).send(body),
      app.post('/api/v1/payments/callback').type('form').send(body),
      webhook(entity, 'evt_dup_1'),
      webhook(entity, 'evt_dup_1'),
    ]);
    expect(results[0].status).toBe(200);
    const sub1 = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
    expect(sub1.status).toBe('ACTIVE');
    expect(await prisma.payment.count({ where: { subscriptionId, status: 'SUCCESS' } })).toBe(1);
    expect(await prisma.subscription.count({ where: { userId: sub1.userId, status: 'ACTIVE' } })).toBe(1);
    expect(sub1.endsAt.getUTCFullYear()).toBe(sub1.startsAt.getUTCFullYear() + 1);
  });

  test('invalid checkout signature never activates', async () => {
    const { auth } = await login(app, '9100000022');
    const sub = await app.post('/api/v1/subscriptions/create').set(auth).send({ planCode: 'annual' });
    const pay = await app.post('/api/v1/payments/create').set(auth).send({ subscriptionId: sub.body.data.subscription.id });
    const res = await app
      .post('/api/v1/payments/verify')
      .set(auth)
      .send({ razorpay_order_id: pay.body.data.checkout.orderId, razorpay_payment_id: 'pay_FORGED0000001', razorpay_signature: 'b'.repeat(64) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_PAYMENT_SIGNATURE');
    expect((await current(auth)).status).toBe('PENDING');
  });

  test('concurrent create/renew requests leave a single pending subscription', async () => {
    const { auth, user } = await login(app, '9100000023');
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      app.post(i % 2 ? '/api/v1/subscriptions/create' : '/api/v1/subscriptions/renew').set(auth).send(i % 2 ? { planCode: 'annual' } : { planCode: 'annual' })));
    results.forEach((r) => expect([200, 201]).toContain(r.status));
    expect(new Set(results.map((r) => r.body.data.subscription.id)).size).toBe(1);
    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(1);
  });

  test('two different periods paid at the same moment do not overlap', async () => {
    const { auth, user } = await login(app, '9100000024');
    const a = await app.post('/api/v1/subscriptions/create').set(auth).send({ planCode: 'annual' });
    const b = await app.post('/api/v1/subscriptions/create').set(auth).send({ planCode: 'monthly' });
    const orders = await Promise.all([a, b].map((s) => app.post('/api/v1/payments/create').set(auth).send({ subscriptionId: s.body.data.subscription.id })));
    const now = Math.floor(Date.now() / 1000);
    await Promise.all(orders.map((o) =>
      webhook({ id: next('pay_CC'), order_id: o.body.data.checkout.orderId, amount: o.body.data.checkout.amount, currency: 'INR', status: 'captured', created_at: now })));

    const periods = await prisma.subscription.findMany({ where: { userId: user.id, status: 'ACTIVE' }, orderBy: { startsAt: 'asc' } });
    expect(periods).toHaveLength(2);
    expect(periods[1].startsAt.getTime()).toBe(periods[0].endsAt.getTime());
  });
});

describe('injectable clock', () => {
  test('getCurrent / eligibility evaluated at a future date see the year as expired', async () => {
    const { user } = await login(app, '9100000030');
    const plan = await prisma.subscriptionPlan.findUnique({ where: { code: 'annual' } });
    const pending = await prisma.subscription.create({ data: { userId: user.id, planId: plan.id, amount: plan.amount, currency: 'INR' } });
    const activated = await prisma.$transaction((tx) => subscriptions.activateSubscription(tx, pending.id, new Date()));

    const midYear = new Date(activated.startsAt.getTime() + 180 * DAY);
    const dueSoon = new Date(activated.endsAt.getTime() - 5 * DAY);
    const nextYear = new Date(activated.endsAt.getTime() + DAY);
    expect((await subscriptions.getCurrent(user.id, midYear)).renewal.allowed).toBe(false);
    expect(await subscriptions.getCurrent(user.id, dueSoon)).toMatchObject({ status: 'ACTIVE', renewal: { allowed: true, reason: 'RENEWAL_DUE' } });
    expect(await subscriptions.getCurrent(user.id, nextYear)).toMatchObject({ status: 'EXPIRED', active: null, renewal: { allowed: true } });
    expect(await subscriptions.findActiveSubscription(user.id, prisma, nextYear)).toBeNull();
  });
});
