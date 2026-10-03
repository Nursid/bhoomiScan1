const request = require('supertest');
const { createApp } = require('../../src/app');
const { prisma } = require('../../src/database/prisma');
const cache = require('../../src/utils/cache');
const { addMonths } = require('../../src/utils/dates');

const TABLES = [
  'api_request_logs',
  'alerts',
  'smart_contract_records',
  'land_record_changes',
  'land_record_snapshots',
  'land_verifications',
  'payment_webhook_events',
  'payments',
  'subscriptions',
  'users',
  'subscription_plans',
];

const PLANS = [
  { code: 'monthly', name: 'Monthly', amount: 59100, currency: 'INR', interval: 'MONTHLY', durationMonths: 1, allowedFrequencies: ['WEEKLY', 'MONTHLY'], maxMonitoredLands: 5 },
  { code: 'quarterly', name: 'Quarterly', amount: 159900, currency: 'INR', interval: 'QUARTERLY', durationMonths: 3, allowedFrequencies: ['WEEKLY', 'MONTHLY', 'QUARTERLY'], maxMonitoredLands: 20 },
];

const resetDb = async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await prisma.subscriptionPlan.createMany({ data: PLANS });
  await cache.clear();
};

/**
 * Replaces global fetch with a router over fake external services.
 * routes: [{ method, url: RegExp, reply: (url, init, body) => ({ status, body, headers }) }]
 */
const installFetch = () => {
  const routes = [];
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = jest.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method, body, headers: init.headers });
    const route = [...routes].reverse().find((r) => r.method === method && r.url.test(url));
    if (!route) throw new TypeError(`fetch failed: no fake route for ${method} ${url}`);
    const result = await route.reply(url, init, body);
    return new Response(JSON.stringify(result.body ?? {}), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json', ...(result.headers || {}) },
    });
  });
  return {
    calls,
    on(method, url, reply) {
      routes.push({ method, url, reply: typeof reply === 'function' ? reply : () => reply });
    },
    callsTo(pattern) {
      return calls.filter((call) => pattern.test(call.url));
    },
    restore() {
      globalThis.fetch = original;
    },
  };
};

const api = () => request(createApp());

const login = async (app, mobile) => {
  const res = await app.post('/api/v1/auth/verify-otp').send({ mobile, otp: '654321' });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { token: res.body.data.token, user: res.body.data.user, auth: { Authorization: `Bearer ${res.body.data.token}` } };
};

const giveActiveSubscription = async (userId, code = 'quarterly') => {
  const plan = await prisma.subscriptionPlan.findUniqueOrThrow({ where: { code } });
  const startsAt = new Date(Date.now() - 60_000);
  return prisma.subscription.create({
    data: { userId, planId: plan.id, status: 'ACTIVE', amount: plan.amount, currency: plan.currency, startsAt, endsAt: addMonths(startsAt, plan.durationMonths), activatedAt: startsAt },
  });
};

// Let fire-and-forget audit-log inserts finish before disconnecting.
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

module.exports = { prisma, resetDb, installFetch, api, login, giveActiveSubscription, settle };
