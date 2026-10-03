/**
 * Alerts/events for users (record changed, verification failed, anchoring failed).
 * Stored in PostgreSQL; `notify` is the hook for push / SMS / email delivery,
 * which currently only logs (no message content beyond ids).
 */

const { prisma } = require('../../database/prisma');
const logger = require('../../utils/logger');
const { notFound } = require('../../utils/errors');

const publicAlert = (alert) => ({
  id: alert.id,
  type: alert.type,
  severity: alert.severity,
  title: alert.title,
  message: alert.message,
  data: alert.data,
  status: alert.status,
  landVerificationId: alert.landVerificationId,
  snapshotId: alert.snapshotId,
  readAt: alert.readAt,
  createdAt: alert.createdAt,
});

const notify = (alert) => {
  logger.info({ alertId: alert.id, userId: alert.userId, type: alert.type, severity: alert.severity }, 'alert created');
};

/** @param {object} [db] prisma or a transaction client */
const createAlert = async (input, db = prisma) => {
  const alert = await db.alert.create({
    data: {
      userId: input.userId,
      landVerificationId: input.landVerificationId || null,
      snapshotId: input.snapshotId || null,
      type: input.type,
      severity: input.severity || 'INFO',
      title: input.title,
      message: input.message,
      data: input.data || undefined,
    },
  });
  // Delivery happens after commit when called inside a transaction.
  if (db === prisma) notify(alert);
  return alert;
};

const listAlerts = async (userId, { status, landVerificationId, skip, limit }) => {
  const where = { userId, ...(status ? { status } : {}), ...(landVerificationId ? { landVerificationId } : {}) };
  const [items, total, unread] = await Promise.all([
    prisma.alert.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
    prisma.alert.count({ where }),
    prisma.alert.count({ where: { userId, status: 'UNREAD' } }),
  ]);
  return { alerts: items.map(publicAlert), total, unread };
};

const markRead = async (userId, alertId) => {
  const alert = await prisma.alert.findFirst({ where: { id: alertId, userId } });
  if (!alert) throw notFound('Alert not found', 'ALERT_NOT_FOUND');
  if (alert.status === 'READ') return publicAlert(alert);
  return publicAlert(await prisma.alert.update({ where: { id: alert.id }, data: { status: 'READ', readAt: new Date() } }));
};

const markAllRead = async (userId) => {
  const { count } = await prisma.alert.updateMany({ where: { userId, status: 'UNREAD' }, data: { status: 'READ', readAt: new Date() } });
  return { updated: count };
};

module.exports = { createAlert, notify, listAlerts, markRead, markAllRead, publicAlert };
