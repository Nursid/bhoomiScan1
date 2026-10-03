/**
 * Plans and subscriptions.
 *
 * A Subscription is created PENDING, becomes ACTIVE only through
 * payments.service after the backend verified the payment with Razorpay
 * (never on the client's word), and becomes EXPIRED when its period ends.
 * Buying again while active stacks a new period after the current one ends.
 */

const { prisma } = require('../../database/prisma');
const logger = require('../../utils/logger');
const { addMonths } = require('../../utils/dates');
const { notFound, conflict } = require('../../utils/errors');

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

const publicSubscription = (subscription) => ({
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
      subscription.startsAt <= new Date() &&
      subscription.endsAt > new Date(),
  ),
  createdAt: subscription.createdAt,
});

/** The subscription granting access right now, or null. */
const findActiveSubscription = async (userId, db = prisma) => {
  const now = new Date();
  return db.subscription.findFirst({
    where: { userId, status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } },
    include: { plan: true },
    orderBy: { endsAt: 'desc' },
  });
};

const createSubscription = async (userId, planCode) => {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { code: planCode } });
  if (!plan || !plan.isActive) {
    throw notFound('Plan not found', 'PLAN_NOT_FOUND');
  }

  // Idempotent: an unpaid subscription for the same plan is reused (double taps, retries).
  const pending = await prisma.subscription.findFirst({
    where: { userId, planId: plan.id, status: { in: ['PENDING', 'FAILED'] } },
    include: { plan: true },
    orderBy: { createdAt: 'desc' },
  });
  if (pending) {
    return { subscription: publicSubscription(pending), reused: true };
  }

  const subscription = await prisma.subscription.create({
    data: { userId, planId: plan.id, status: 'PENDING', amount: plan.amount, currency: plan.currency },
    include: { plan: true },
  });
  logger.info({ userId, subscriptionId: subscription.id, plan: plan.code }, 'subscription created');
  return { subscription: publicSubscription(subscription), reused: false };
};

const listSubscriptions = async (userId) => {
  const subscriptions = await prisma.subscription.findMany({ where: { userId }, include: { plan: true }, orderBy: { createdAt: 'desc' } });
  return subscriptions.map(publicSubscription);
};

const getCurrent = async (userId) => {
  const active = await findActiveSubscription(userId);
  const upcoming = await prisma.subscription.findMany({
    where: { userId, status: 'ACTIVE', startsAt: { gt: new Date() } },
    include: { plan: true },
    orderBy: { startsAt: 'asc' },
  });
  return { active: active ? publicSubscription(active) : null, upcoming: upcoming.map(publicSubscription) };
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
const activateSubscription = async (tx, subscriptionId, paidAt = new Date()) => {
  const subscription = await tx.subscription.findUnique({ where: { id: subscriptionId }, include: { plan: true } });
  if (!subscription) {
    throw notFound('Subscription not found', 'SUBSCRIPTION_NOT_FOUND');
  }
  if (subscription.status === 'ACTIVE') {
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
  createSubscription,
  listSubscriptions,
  getCurrent,
  cancelSubscription,
  activateSubscription,
  expireDueSubscriptions,
};
