const { prisma } = require('../../database/prisma');
const { notFound } = require('../../utils/errors');
const { paginationMeta } = require('../../utils/response');

const DAY_MS = 24 * 60 * 60 * 1000;
const toRupees = (paise) => (paise || 0) / 100;
const daysBetween = (from, to) => Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
const activeWhere = (now) => ({ status: 'ACTIVE', startsAt: { lte: now }, endsAt: { gt: now } });

const subscriptionView = (subscription) => ({
  id: subscription.id,
  planCode: subscription.plan.code,
  planName: subscription.plan.name,
  status: subscription.status,
  amountRupees: toRupees(subscription.amount),
  subscribedAt: subscription.activatedAt || subscription.createdAt,
  startsAt: subscription.startsAt,
  endsAt: subscription.endsAt,
});

const paymentView = (payment) => ({
  id: payment.id,
  payId: payment.providerPaymentId || null, // Razorpay pay_xxx (null until the user pays)
  orderId: payment.providerOrderId,
  status: payment.status, // CREATED | SUCCESS | FAILED | REFUNDED
  amountRupees: toRupees(payment.amount),
  currency: payment.currency,
  method: payment.method,
  failureReason: payment.failureReason,
  planName: payment.subscription?.plan?.name || null,
  paidAt: payment.verifiedAt,
  createdAt: payment.createdAt,
});

const landView = (land, record) => ({
  id: land.id,
  displayName: land.displayName,
  state: land.stateCode,
  provider: land.provider,
  status: land.status,
  locator: land.locator,
  verificationCount: land.verificationCount,
  changeCount: land.changeCount,
  firstVerifiedAt: land.firstVerifiedAt,
  lastVerifiedAt: land.lastVerifiedAt,
  lastError: land.lastErrorCode ? { code: land.lastErrorCode, message: land.lastErrorMessage } : null,
  monitoring: { enabled: land.monitoringEnabled, frequency: land.verificationFrequency, nextVerificationAt: land.nextVerificationAt },
  record: record || null, // latest stored land record (normalized provider data), if any
  createdAt: land.createdAt,
});

/** `paid` = { amount (paise), lastPaidAt, count } for this user's SUCCESS payments. */
const userRow = (user, now, paid) => {
  const active = user.subscriptions.find((s) => s.status === 'ACTIVE' && s.startsAt && s.endsAt && s.startsAt <= now && s.endsAt > now);
  const shown = active || user.subscriptions[0] || null; // newest first
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.mobile,
    role: user.role,
    status: user.status,
    subscribed: Boolean(active),
    planName: shown ? shown.plan.name : null,
    planAmountRupees: shown ? toRupees(shown.amount) : 0,
    subscribedAt: shown ? shown.activatedAt || shown.createdAt : null,
    subscriptionEndsAt: shown ? shown.endsAt : null,
    daysLeft: active ? Math.max(daysBetween(now, active.endsAt), 0) : null,
    totalPaidRupees: toRupees(paid?.amount),
    paidPaymentCount: paid?.count || 0,
    lastPaidAt: paid?.lastPaidAt || null,
    landCount: user._count?.landVerifications ?? 0,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
  };
};

const listUsers = async ({ page, limit, skip, search, subscribed, status }) => {
  const now = new Date();
  const and = [];
  if (search) {
    and.push({
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { mobile: { contains: search } },
      ],
    });
  }
  and.push({ role: 'USER' });
  if (status) and.push({ status });
  if (subscribed === true) and.push({ subscriptions: { some: activeWhere(now) } });
  if (subscribed === false) and.push({ subscriptions: { none: activeWhere(now) } });
  const where = { AND: and };

  const [total, users] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      relationLoadStrategy: 'join',
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        _count: { select: { landVerifications: true } },
        subscriptions: {
          where: { status: { in: ['ACTIVE', 'EXPIRED', 'CANCELLED'] } },
          include: { plan: { select: { code: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
    }),
  ]);

  // Total paid + last paid date, only for the users on this page.
  const paidGroups = users.length
    ? await prisma.payment.groupBy({
        by: ['userId'],
        where: { status: 'SUCCESS', userId: { in: users.map((user) => user.id) } },
        _sum: { amount: true },
        _max: { verifiedAt: true },
        _count: { _all: true },
      })
    : [];
  const paidByUser = new Map(
    paidGroups.map((group) => [group.userId, { amount: group._sum.amount || 0, lastPaidAt: group._max.verifiedAt, count: group._count._all }]),
  );

  return { users: users.map((user) => userRow(user, now, paidByUser.get(user.id))), meta: paginationMeta({ page, limit }, total) };
};

const getUser = async (id) => {
  const now = new Date();
  const [user, payments, lands, paidAgg] = await Promise.all([
    prisma.user.findUnique({
      where: { id },
      relationLoadStrategy: 'join',
      include: {
        _count: { select: { landVerifications: true } },
        subscriptions: { include: { plan: { select: { code: true, name: true } } }, orderBy: { createdAt: 'desc' }, take: 50 },
      },
    }),
    prisma.payment.findMany({
      relationLoadStrategy: 'join',
      where: { userId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { subscription: { select: { plan: { select: { name: true } } } } },
    }),
    prisma.landVerification.findMany({ where: { userId: id }, orderBy: { createdAt: 'desc' }, take: 50 }),
    prisma.payment.aggregate({ where: { userId: id, status: 'SUCCESS' }, _sum: { amount: true }, _max: { verifiedAt: true }, _count: { _all: true } }),
  ]);
  if (!user) throw notFound('User not found', 'USER_NOT_FOUND');

  const snapshotIds = lands.map((land) => land.latestSnapshotId).filter(Boolean);
  const snapshots = snapshotIds.length
    ? await prisma.landRecordSnapshot.findMany({ where: { id: { in: snapshotIds } }, select: { id: true, normalizedData: true } })
    : [];
  const recordById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot.normalizedData]));

  const paid = { amount: paidAgg._sum.amount || 0, lastPaidAt: paidAgg._max.verifiedAt, count: paidAgg._count._all };
  return {
    ...userRow(user, now, paid),
    subscriptions: user.subscriptions.map(subscriptionView),
    payments: payments.map(paymentView),
    lands: lands.map((land) => landView(land, recordById.get(land.latestSnapshotId))),
  };
};

const getSummary = async () => {
  const now = new Date();
  const [totalUsers, subscribedUsers] = await Promise.all([
    prisma.user.count({ where: { role: 'USER' } }),
    prisma.user.count({ where: { role: 'USER', subscriptions: { some: activeWhere(now) } } }),
  ]);
  return { totalUsers, subscribedUsers, unsubscribedUsers: totalUsers - subscribedUsers };
};

module.exports = { listUsers, getUser, getSummary };
