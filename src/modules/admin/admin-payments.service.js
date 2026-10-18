const { prisma } = require('../../database/prisma');
const { paginationMeta } = require('../../utils/response');

const userView = (user) => (user ? { id: user.id, name: user.name, email: user.email, phone: user.mobile } : null);

const paymentRow = (payment) => ({
  id: payment.id,
  status: payment.status, // CREATED (not paid yet) | SUCCESS | FAILED | REFUNDED
  amount: payment.amount, // paise
  amountRupees: payment.amount / 100,
  currency: payment.currency,
  method: payment.method,
  failureReason: payment.failureReason,
  orderId: payment.providerOrderId,
  razorpayPaymentId: payment.providerPaymentId,
  planName: payment.subscription?.plan?.name || null,
  user: userView(payment.user),
  paidAt: payment.verifiedAt,
  createdAt: payment.createdAt,
});

const listPayments = async ({ page, limit, skip, status, search }) => {
  const where = {
    ...(status ? { status } : {}),
    ...(search
      ? {
          OR: [
            { providerOrderId: { contains: search } },
            { providerPaymentId: { contains: search } },
            { user: { is: { name: { contains: search, mode: 'insensitive' } } } },
            { user: { is: { email: { contains: search, mode: 'insensitive' } } } },
            { user: { is: { mobile: { contains: search } } } },
          ],
        }
      : {}),
  };
  const [total, payments] = await Promise.all([
    prisma.payment.count({ where }),
    prisma.payment.findMany({
      relationLoadStrategy: 'join',
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: {
        user: { select: { id: true, name: true, email: true, mobile: true } },
        subscription: { select: { plan: { select: { name: true } } } },
      },
    }),
  ]);
  return { payments: payments.map(paymentRow), meta: paginationMeta({ page, limit }, total) };
};

const getPaymentSummary = async () => {
  const groups = await prisma.payment.groupBy({ by: ['status'], _count: { _all: true }, _sum: { amount: true } });
  const byStatus = Object.fromEntries(['CREATED', 'SUCCESS', 'FAILED', 'REFUNDED'].map((s) => [s, 0]));
  let revenue = 0;
  for (const group of groups) {
    byStatus[group.status] = group._count._all;
    if (group.status === 'SUCCESS') revenue = group._sum.amount || 0;
  }
  return { counts: byStatus, totalRevenue: revenue, totalRevenueRupees: revenue / 100 };
};

const alertRow = (alert) => ({
  id: alert.id,
  type: alert.type,
  severity: alert.severity,
  title: alert.title,
  message: alert.message,
  data: alert.data,
  user: userView(alert.user),
  createdAt: alert.createdAt,
});

const PAYMENT_ALERT_TYPES = ['PAYMENT_SUCCESS', 'PAYMENT_FAILED'];

const listPaymentAlerts = async ({ page, limit, skip, type }) => {
  const where = { type: type ? type : { in: PAYMENT_ALERT_TYPES } };
  const [total, alerts] = await Promise.all([
    prisma.alert.count({ where }),
    prisma.alert.findMany({
      relationLoadStrategy: 'join',
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
      include: { user: { select: { id: true, name: true, email: true, mobile: true } } },
    }),
  ]);
  return { alerts: alerts.map(alertRow), meta: paginationMeta({ page, limit }, total) };
};

module.exports = { listPayments, getPaymentSummary, listPaymentAlerts };
