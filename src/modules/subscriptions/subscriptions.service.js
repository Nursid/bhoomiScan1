/**
 * Plans and subscriptions.
 *
 * A Subscription is created PENDING, becomes ACTIVE only through
 * payments.service after the backend verified the payment with Razorpay
 * (never on the client's word), and becomes EXPIRED when its period ends.
 *
 * Renewal is manual: a new period can be bought when the user has no paid
 * period left, or within SUBSCRIPTION_RENEWAL_WINDOW_DAYS of the end of the
 * last one. A renewal bought early starts when the current period ends (no
 * days lost); one bought after expiry starts at payment time. Each period is
 * its own Subscription row, so the rows (+ payments) are the renewal history.
 *
 * Subscription changes for one user are serialized with a transaction-scoped
 * advisory lock, so concurrent purchases / activations cannot create duplicate
 * pending subscriptions or overlapping periods.
 */

const { prisma } = require('../../database/prisma');
const config = require('../../config');
const logger = require('../../utils/logger');
const { addDays, addMonths } = require('../../utils/dates');
const { notFound, conflict } = require('../../utils/errors');

/** Serializes subscription changes for one user until the surrounding transaction ends. */
const lockUser = (tx, userId) =>
  tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtextextended(${`subscription:${userId}`}, 0))) AS l`;

/* --------------------------------- Plans --------------------------------- */

const publicPlan = (plan) => ({
  id: plan.id,
  code: plan.code,
  name: plan.name,
  description: plan.description,
  amount: plan.amount,
  amountDisplay: (plan.amount / 100).toFixed(2),
  currency: plan.currency,
  interval: plan.interval,
  durationMonths: plan.durationMonths,
  allowedFrequencies: plan.allowedFrequencies,
  maxMonitoredLands: plan.maxMonitoredLands,
  features: plan.features,
});

const listPlans = async () => {
  const plans = await prisma.subscriptionPlan.findMany({ where: { isActive: true }, orderBy: [{ sortOrder: 'asc' }, { amount: 'asc' }] });
  return plans.map(publicPlan);
};

/* ----------------------------- Subscriptions ----------------------------- */

const publicSubscription = (subscription, now = new Date()) => ({
  id: subscription.id,
  status: subscription.status,
  plan: subscription.plan ? publicPlan(subscription.plan) : undefined,
  planId: subscription.planId,
  amount: subscription.amount,
  currency: subscription.currency,
  startsAt: subscription.startsAt,
  endsAt: subscription.endsAt,
  activatedAt: subscription.activatedAt,
  cancelledAt: subscription.cancelledAt,
  expiredAt: subscription.expiredAt,
  isCurrent: Boolean(
    subscription.status === 'ACTIVE' &&
      subscription.startsAt &&
      subscription.endsAt &&
      subscription.startsAt <= now &&
      subscription.endsAt > now,
  ),
  createdAt: subscription.createdAt,
});

/** The subscription granting access right now, or null. */
const findActiveSubscription = async (userId, db = prisma, now = new Date()) =>
  db.subscription.findFirst({
    where: { userId, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } },
    include: { plan: true },
    orderBy: { endsAt: 'desc' },
  });

/**
 * Whether the user may buy a period now. Paid time is never cut short: a new
 * period is only sold once the last paid period (current or already-renewed
 * upcoming one) is inside the renewal window, or over.
 * @returns {{ allowed: boolean, reason: string, paidUntil: Date|null, renewableFrom: Date|null }}
 */
const purchaseEligibility = async (userId, db = prisma, now = new Date()) => {
  const lastPaid = await db.subscription.findFirst({
    where: { userId, status: 'ACTIVE', endsAt: { gt: now } },
    orderBy: { endsAt: 'desc' },
  });
  if (!lastPaid) {
    return { allowed: true, reason: 'NO_ACTIVE_SUBSCRIPTION', paidUntil: null, renewableFrom: null };
  }
  const renewableFrom = addDays(lastPaid.endsAt, -config.subscriptions.renewalWindowDays);
  return {
    allowed: now >= renewableFrom,
    reason: now >= renewableFrom ? 'RENEWAL_DUE' : 'SUBSCRIPTION_ALREADY_ACTIVE',
    paidUntil: lastPaid.endsAt,
    renewableFrom,
  };
};

const assertCanPurchase = async (userId, db = prisma, now = new Date()) => {
  const eligibility = await purchaseEligibility(userId, db, now);
  if (!eligibility.allowed) {
    throw conflict(
      `Your plan is already paid until ${eligibility.paidUntil.toISOString().slice(0, 10)}. Renewal opens on ${eligibility.renewableFrom.toISOString().slice(0, 10)}.`,
      { paidUntil: eligibility.paidUntil, renewableFrom: eligibility.renewableFrom },
      'SUBSCRIPTION_ALREADY_ACTIVE',
    );
  }
  return eligibility;
};

const createSubscription = async (userId, planCode, now = new Date()) => {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { code: planCode } });
  if (!plan || !plan.isActive) {
    throw notFound('Plan not found', 'PLAN_NOT_FOUND');
  }

  return prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    await assertCanPurchase(userId, tx, now);

    // Idempotent: an unpaid subscription for the same plan is reused (double taps, retries).
    const pending = await tx.subscription.findFirst({
      where: { userId, planId: plan.id, status: { in: ['PENDING', 'FAILED'] } },
      include: { plan: true },
      orderBy: { createdAt: 'desc' },
    });
    if (pending) {
      return { subscription: publicSubscription(pending, now), reused: true };
    }

    const subscription = await tx.subscription.create({
      data: { userId, planId: plan.id, status: 'PENDING', amount: plan.amount, currency: plan.currency },
      include: { plan: true },
    });
    logger.info({ userId, subscriptionId: subscription.id, plan: plan.code }, 'subscription created');
    return { subscription: publicSubscription(subscription, now), reused: false };
  });
};

/** The most recent period the user actually paid for (any outcome), or null. */
const findLatestPaid = (userId, db = prisma) =>
  db.subscription.findFirst({
    where: { userId, activatedAt: { not: null } },
    include: { plan: true },
    orderBy: [{ endsAt: 'desc' }, { activatedAt: 'desc' }],
  });

/** Renew Plan: buy the next period of the last paid plan, or of `planCode` (plan change). */
const renewSubscription = async (userId, planCode, now = new Date()) => {
  let code = planCode;
  if (!code) {
    const latest = await findLatestPaid(userId);
    if (!latest) {
      throw conflict('There is no previous plan to renew; choose a plan', undefined, 'NOTHING_TO_RENEW');
    }
    if (!latest.plan.isActive) {
      throw conflict('Your previous plan is no longer offered; choose a plan', { planCode: latest.plan.code }, 'PLAN_UNAVAILABLE');
    }
    code = latest.plan.code;
  }
  return createSubscription(userId, code, now);
};

const listSubscriptions = async (userId) => {
  const subscriptions = await prisma.subscription.findMany({ where: { userId }, include: { plan: true }, orderBy: { createdAt: 'desc' } });
  return subscriptions.map((subscription) => publicSubscription(subscription));
};

/**
 * Everything the subscription page needs:
 *   status   ACTIVE | EXPIRED | CANCELLED | PENDING | NONE (by dates, not by the expiry job)
 *   active   period granting access now      upcoming  already-paid next periods
 *   latest   last paid period (shown when expired)   pending  unpaid subscription, if any
 *   renewal  whether Renew is available now, and from when
 */
const getCurrent = async (userId, now = new Date()) => {
  const [active, upcoming, latest, pending, eligibility] = await Promise.all([
    findActiveSubscription(userId, prisma, now),
    prisma.subscription.findMany({
      where: { userId, status: 'ACTIVE', startsAt: { gt: now } },
      include: { plan: true },
      orderBy: { startsAt: 'asc' },
    }),
    findLatestPaid(userId),
    prisma.subscription.findFirst({ where: { userId, status: 'PENDING' }, include: { plan: true }, orderBy: { createdAt: 'desc' } }),
    purchaseEligibility(userId, prisma, now),
  ]);

  let status = 'NONE';
  if (active) status = 'ACTIVE';
  else if (latest) status = latest.status === 'CANCELLED' ? 'CANCELLED' : 'EXPIRED';
  else if (pending) status = 'PENDING';

  const renewPlan = latest?.plan?.isActive ? latest.plan.code : null;
  return {
    status,
    active: active ? publicSubscription(active, now) : null,
    upcoming: upcoming.map((subscription) => publicSubscription(subscription, now)),
    latest: latest ? publicSubscription(latest, now) : null,
    pending: pending ? publicSubscription(pending, now) : null,
    renewal: {
      allowed: eligibility.allowed,
      reason: eligibility.reason,
      paidUntil: eligibility.paidUntil,
      renewableFrom: eligibility.renewableFrom,
      windowDays: config.subscriptions.renewalWindowDays,
      planCode: renewPlan,
    },
  };
};

const cancelSubscription = async (userId, subscriptionId) => {
  const subscription = await prisma.subscription.findFirst({ where: { id: subscriptionId, userId } });
  if (!subscription) {
    throw notFound('Subscription not found', 'SUBSCRIPTION_NOT_FOUND');
  }
  if (!['PENDING', 'FAILED'].includes(subscription.status)) {
    throw conflict('Only unpaid subscriptions can be cancelled; paid periods run until they end', { status: subscription.status }, 'SUBSCRIPTION_NOT_CANCELLABLE');
  }
  const updated = await prisma.subscription.update({
    where: { id: subscription.id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
    include: { plan: true },
  });
  return publicSubscription(updated);
};

/**
 * Activates a paid subscription inside the caller's transaction. Idempotent: an
 * already ACTIVE subscription is returned unchanged. The new period starts now,
 * or when the user's latest active period ends (renewal before expiry).
 */
const activateSubscription = async (tx, subscriptionId, paidAt = new Date(), { onAlreadyActive } = {}) => {
  const owner = await tx.subscription.findUnique({ where: { id: subscriptionId }, select: { userId: true } });
  if (!owner) {
    throw notFound('Subscription not found', 'SUBSCRIPTION_NOT_FOUND');
  }
  // Two periods paid at the same moment must not both start at the same "latest end".
  await lockUser(tx, owner.userId);
  const subscription = await tx.subscription.findUnique({ where: { id: subscriptionId }, include: { plan: true } });
  if (subscription.status === 'ACTIVE') {
    onAlreadyActive?.(subscription);
    return subscription;
  }

  const latest = await tx.subscription.findFirst({
    where: { userId: subscription.userId, status: 'ACTIVE', endsAt: { gt: paidAt } },
    orderBy: { endsAt: 'desc' },
  });
  const startsAt = latest ? latest.endsAt : paidAt;
  const endsAt = addMonths(startsAt, subscription.plan.durationMonths);

  const activated = await tx.subscription.update({
    where: { id: subscription.id },
    data: { status: 'ACTIVE', startsAt, endsAt, activatedAt: paidAt, cancelledAt: null },
    include: { plan: true },
  });
  logger.info({ subscriptionId, userId: subscription.userId, startsAt, endsAt }, 'subscription activated');
  return activated;
};

/** Marks ACTIVE subscriptions whose period has ended as EXPIRED. */
const expireDueSubscriptions = async (now = new Date()) => {
  const { count } = await prisma.subscription.updateMany({
    where: { status: 'ACTIVE', endsAt: { lte: now } },
    data: { status: 'EXPIRED', expiredAt: now },
  });
  if (count > 0) {
    logger.info({ count }, 'subscriptions expired');
  }
  return count;
};

module.exports = {
  publicPlan,
  publicSubscription,
  listPlans,
  findActiveSubscription,
  purchaseEligibility,
  assertCanPurchase,
  createSubscription,
  renewSubscription,
  listSubscriptions,
  getCurrent,
  cancelSubscription,
  activateSubscription,
  expireDueSubscriptions,
};
