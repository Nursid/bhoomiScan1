const { prisma } = require('../../database/prisma');

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_WITHIN_DAYS = 7;
const CHART_MONTHS = 6;

const activeWhere = (now) => ({ status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } });
const toRupees = (paise) => (paise || 0) / 100;
const daysBetween = (from, to) => Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
const monthKey = (date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

const userView = (user) => (user ? { id: user.id, name: user.name, email: user.email, phone: user.mobile } : null);

/** Last N calendar months (UTC), oldest first, each with its successful-payment total. */
const buildRevenueByMonth = (payments, now) => {
  const buckets = [];
  for (let i = CHART_MONTHS - 1; i >= 0; i -= 1) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    buckets.push({ key: monthKey(date), month: date.toISOString(), amount: 0, count: 0 });
  }
  const byKey = new Map(buckets.map((bucket) => [bucket.key, bucket]));
  for (const payment of payments) {
    const bucket = byKey.get(monthKey(payment.verifiedAt));
    if (bucket) {
      bucket.amount += payment.amount;
      bucket.count += 1;
    }
  }
  return buckets.map(({ key, month, amount, count }) => ({ key, month, amountRupees: toRupees(amount), count }));
};

const paymentRow = (payment) => ({
  id: payment.id,
  payId: payment.providerPaymentId || null, // Razorpay pay_xxx (null until the user actually pays)
  orderId: payment.providerOrderId,
  status: payment.status, // CREATED | SUCCESS | FAILED | REFUNDED
  amountRupees: toRupees(payment.amount),
  currency: payment.currency,
  method: payment.method,
  planName: payment.subscription?.plan?.name || null,
  paidAt: payment.verifiedAt,
  createdAt: payment.createdAt,
  user: userView(payment.user),
});

const subscriberRow = (user, now, paidByUser) => {
  const active = user.subscriptions.find((s) => s.status === 'ACTIVE' && s.startsAt && s.endsAt && s.startsAt <= now && s.endsAt > now);
  const shown = active || user.subscriptions[0] || null;
  const paid = paidByUser.get(user.id);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.mobile,
    status: user.status,
    subscribed: Boolean(active), // true = paid plan running, false = free
    planName: shown ? shown.plan.name : null,
    planAmountRupees: shown ? toRupees(shown.amount) : 0,
    subscriptionEndsAt: shown ? shown.endsAt : null,
    daysLeft: active ? Math.max(daysBetween(now, active.endsAt), 0) : null,
    totalPaidRupees: toRupees(paid?.amount),
    lastPaidAt: paid?.lastPaidAt || null,
    joinedAt: user.createdAt,
  };
};

const getOverview = async () => {
  const now = new Date();
  const expiringLimit = new Date(now.getTime() + EXPIRING_WITHIN_DAYS * DAY_MS);
  const chartStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (CHART_MONTHS - 1), 1));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const expiringWhere = { ...activeWhere(now), endsAt: { gt: now, lte: expiringLimit } };

  const [totalUsers, subscribedUsers, paymentGroups, landsTracked, expiringCount, expiring, recentPayments, recentUsers, chartPayments] =
    await Promise.all([
      prisma.user.count({ where: { role: 'USER' } }),
      prisma.user.count({ where: { role: 'USER', subscriptions: { some: activeWhere(now) } } }),
      prisma.payment.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } }),
      prisma.landVerification.count(),
      prisma.subscription.count({ where: expiringWhere }),
      prisma.subscription.findMany({
        relationLoadStrategy: 'join',
        where: expiringWhere,
        orderBy: { endsAt: 'asc' },
        take: 5,
        include: {
          user: { select: { id: true, name: true, email: true, mobile: true } },
          plan: { select: { name: true } },
        },
      }),
      prisma.payment.findMany({
        relationLoadStrategy: 'join',
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          user: { select: { id: true, name: true, email: true, mobile: true } },
          subscription: { select: { plan: { select: { name: true } } } },
        },
      }),
      prisma.user.findMany({
        relationLoadStrategy: 'join',
        where: { role: 'USER' },
        orderBy: { createdAt: 'desc' },
        take: 8,
        include: {
          subscriptions: {
            where: { status: { in: ['ACTIVE', 'EXPIRED', 'CANCELLED'] } },
            include: { plan: { select: { name: true } } },
            orderBy: { createdAt: 'desc' },
            take: 5,
          },
        },
      }),
      prisma.payment.findMany({
        where: { status: 'SUCCESS', verifiedAt: { gte: chartStart } },
        select: { amount: true, verifiedAt: true },
      }),
    ]);

  const counts = { CREATED: 0, SUCCESS: 0, FAILED: 0, REFUNDED: 0 };
  let totalRevenue = 0;
  for (const group of paymentGroups) {
    counts[group.status] = group._count._all;
    if (group.status === 'SUCCESS') totalRevenue = group._sum.amount || 0;
  }

  // Total paid + last paid date for just the users shown in "recent subscribers".
  const paidGroups = recentUsers.length
    ? await prisma.payment.groupBy({
        by: ['userId'],
        where: { status: 'SUCCESS', userId: { in: recentUsers.map((user) => user.id) } },
        _sum: { amount: true },
        _max: { verifiedAt: true },
      })
    : [];
  const paidByUser = new Map(paidGroups.map((group) => [group.userId, { amount: group._sum.amount || 0, lastPaidAt: group._max.verifiedAt }]));

  const thisMonthRevenue = chartPayments.filter((p) => p.verifiedAt >= monthStart).reduce((sum, p) => sum + p.amount, 0);

  return {
    generatedAt: now,
    stats: {
      totalUsers,
      paidUsers: subscribedUsers,
      freeUsers: totalUsers - subscribedUsers,
      totalRevenueRupees: toRupees(totalRevenue),
      thisMonthRevenueRupees: toRupees(thisMonthRevenue),
      payments: counts,
      landsTracked,
      expiringSoonCount: expiringCount,
      expiringWithinDays: EXPIRING_WITHIN_DAYS,
    },
    revenueByMonth: buildRevenueByMonth(chartPayments, now),
    expiringSoon: expiring.map((subscription) => ({
      subscriptionId: subscription.id,
      planName: subscription.plan.name,
      amountRupees: toRupees(subscription.amount),
      endsAt: subscription.endsAt,
      daysLeft: Math.max(daysBetween(now, subscription.endsAt), 0),
      user: userView(subscription.user),
    })),
    recentSubscribers: recentUsers.map((user) => subscriberRow(user, now, paidByUser)),
    recentPayments: recentPayments.map(paymentRow),
  };
};

module.exports = { getOverview };
