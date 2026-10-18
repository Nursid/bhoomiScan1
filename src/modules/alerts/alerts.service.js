/**
 * Alerts/events for users (record changed, verification failed, anchoring failed,
 * payment results). Stored in Catalyst Data Store; `notify` is the hook for
 * push / SMS / email delivery, which currently only logs (no message content beyond ids).
 */

const { randomUUID } = require('crypto');
const db = require('../../database');
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

/**
 * @param {object} input
 * @param {string} [input.id]  deterministic id from callers whose workflow may be retried,
 *                             so a retry finds the existing alert instead of adding a second
 * @param {object} [options]
 * @param {boolean} [options.deferNotify]  caller calls notify() once its whole workflow is stored
 */
const createAlert = async (input, { deferNotify = false } = {}) => {
  if (input.id) {
    const existing = await db.alerts.findById(input.id);
    if (existing) return existing;
  }
  const alert = await db.alerts.insert({
    id: input.id || randomUUID(),
    userId: input.userId,
    landVerificationId: input.landVerificationId || null,
    snapshotId: input.snapshotId || null,
    type: input.type,
    severity: input.severity || 'INFO',
    title: input.title,
    message: input.message,
    data: input.data || null,
    status: 'UNREAD',
  });
  if (!deferNotify) notify(alert);
  return alert;
};

const listAlerts = async (userId, { status, landVerificationId, skip, limit }) => {
  const where = { userId, ...(status ? { status } : {}), ...(landVerificationId ? { landVerificationId } : {}) };
  const [items, total, unread] = await Promise.all([
    db.alerts.findMany({ where, orderBy: [['createdAt', 'desc']], offset: skip, limit }),
    db.alerts.count(where),
    db.alerts.count({ userId, status: 'UNREAD' }),
  ]);
  return { alerts: items.map(publicAlert), total, unread };
};

const markRead = async (userId, alertId) => {
  const alert = await db.alerts.findOne({ id: alertId, userId });
  if (!alert) throw notFound('Alert not found', 'ALERT_NOT_FOUND');
  if (alert.status === 'READ') return publicAlert(alert);
  return publicAlert(await db.alerts.updateById(alert.id, { status: 'READ', readAt: new Date() }));
};

const markAllRead = async (userId) => {
  const updated = await db.alerts.updateWhere({ userId, status: 'UNREAD' }, { status: 'READ', readAt: new Date() });
  return { updated: updated.length };
};

module.exports = { createAlert, notify, listAlerts, markRead, markAllRead, publicAlert };
