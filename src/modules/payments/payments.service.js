/**
 * Razorpay payments for subscriptions.
 *
 *   create   -> Razorpay order for a PENDING subscription (amount from the DB, never the client)
 *   verify   -> checkout signature check + server-side fetch of the payment from Razorpay
 *               (status, order id, amount, currency) before anything is activated
 *   webhook  -> signature-verified, idempotent (event id), source of truth for
 *               captured / failed / refunded payments
 *
 * Success is applied by `applyPaymentSuccess`, which is idempotent and runs in a
 * transaction together with subscription activation, so the client verify call
 * and the webhook can race safely.
 */

const { randomBytes, createHash } = require('crypto');
const { Prisma } = require('@prisma/client');
const { prisma } = require('../../database/prisma');
const razorpay = require('../../integrations/razorpay/razorpay.client');
const subscriptionsService = require('../subscriptions/subscriptions.service');
const logger = require('../../utils/logger');
const { fromUnixSeconds } = require('../../utils/dates');
const { AppError, notFound, conflict, badRequest } = require('../../utils/errors');

const publicPayment = (payment) => ({
  id: payment.id,
  subscriptionId: payment.subscriptionId,
  status: payment.status,
  amount: payment.amount,
  currency: payment.currency,
  orderId: payment.providerOrderId,
  paymentId: payment.providerPaymentId,
  method: payment.method,
  failureReason: payment.failureReason,
  verifiedAt: payment.verifiedAt,
  refundedAt: payment.refundedAt,
  createdAt: payment.createdAt,
});

/** Only non-sensitive fields of a Razorpay payment entity are stored. */
const auditEntity = (entity) =>
  entity
    ? {
        id: entity.id,
        entity: entity.entity,
        status: entity.status,
        order_id: entity.order_id,
        amount: entity.amount,
        amount_refunded: entity.amount_refunded,
        currency: entity.currency,
        method: entity.method,
        captured: entity.captured,
        error_code: entity.error_code,
        error_reason: entity.error_reason,
        created_at: entity.created_at,
      }
    : null;

const newReceipt = () => `bs_${Date.now().toString(36)}_${randomBytes(6).toString('hex')}`;

/* --------------------------------- Create -------------------------------- */

const createPayment = async (userId, subscriptionId) => {
  const subscription = await prisma.subscription.findFirst({ where: { id: subscriptionId, userId }, include: { plan: true } });
  if (!subscription) {
    throw notFound('Subscription not found', 'SUBSCRIPTION_NOT_FOUND');
  }
  if (!['PENDING', 'FAILED'].includes(subscription.status)) {
    throw conflict('This subscription is not awaiting payment', { status: subscription.status }, 'SUBSCRIPTION_NOT_PAYABLE');
  }

  const receipt = newReceipt();
  const order = await razorpay.createOrder({
    amount: subscription.amount,
    currency: subscription.currency,
    receipt,
    notes: { subscriptionId: subscription.id, userId, plan: subscription.plan.code },
  });
  if (!order?.id || order.amount !== subscription.amount) {
    throw new AppError(502, 'PAYMENT_PROVIDER_INVALID_RESPONSE', 'Payment provider returned an unexpected order');
  }

  const payment = await prisma.$transaction(async (tx) => {
    if (subscription.status === 'FAILED') {
      await tx.subscription.update({ where: { id: subscription.id }, data: { status: 'PENDING' } });
    }
    return tx.payment.create({
      data: {
        userId,
        subscriptionId: subscription.id,
        receipt,
        providerOrderId: order.id,
        amount: order.amount,
        currency: order.currency,
        status: 'CREATED',
        providerData: { order: { id: order.id, status: order.status, amount: order.amount, currency: order.currency } },
      },
    });
  });
  logger.info({ userId, paymentId: payment.id, orderId: order.id }, 'payment order created');

  // Everything the mobile app needs to open Razorpay Checkout.
  return {
    payment: publicPayment(payment),
    checkout: {
      keyId: razorpay.getKeyId(),
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      name: 'BhoomiScan',
      description: `${subscription.plan.name} subscription`,
    },
  };
};

/* ------------------------- Shared success / failure ----------------------- */

const assertEntityMatchesPayment = (payment, entity) => {
  if (entity.order_id !== payment.providerOrderId || entity.amount !== payment.amount || entity.currency !== payment.currency) {
    logger.error(
      { paymentId: payment.id, orderId: payment.providerOrderId, entityOrder: entity.order_id, entityAmount: entity.amount },
      'razorpay payment does not match our order',
    );
    throw new AppError(400, 'PAYMENT_MISMATCH', 'Payment details do not match the order');
  }
};

/**
 * Marks the payment SUCCESS and activates its subscription (one transaction).
 * Safe to call repeatedly / concurrently: only the first call changes anything.
 */
const applyPaymentSuccess = async (payment, entity, via) => {
  const paidAt = fromUnixSeconds(entity.created_at) || new Date();
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: { in: ['CREATED', 'FAILED'] } },
      data: {
        status: 'SUCCESS',
        providerPaymentId: entity.id,
        method: entity.method || null,
        failureReason: null,
        verifiedVia: via,
        verifiedAt: new Date(),
        providerData: { ...(payment.providerData || {}), payment: auditEntity(entity) },
      },
    });
    const current = await tx.payment.findUnique({ where: { id: payment.id } });
    if (count === 0) {
      if (current.status === 'SUCCESS' && current.providerPaymentId !== entity.id) {
        // A second successful payment on an already-paid order: keep for reconciliation.
        logger.error({ paymentId: payment.id, existing: current.providerPaymentId, incoming: entity.id }, 'duplicate capture on paid order');
      }
      const subscription = await tx.subscription.findUnique({ where: { id: payment.subscriptionId }, include: { plan: true } });
      return { payment: current, subscription, alreadyProcessed: true };
    }
    const subscription = await subscriptionsService.activateSubscription(tx, payment.subscriptionId, paidAt);
    logger.info({ paymentId: payment.id, subscriptionId: subscription.id, via }, 'payment succeeded');
    return { payment: current, subscription, alreadyProcessed: false };
  });
};

const applyPaymentFailure = async (payment, entity) => {
  const reason = [entity?.error_code, entity?.error_description || entity?.error_reason].filter(Boolean).join(': ') || 'Payment failed';
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: 'CREATED' },
      data: {
        status: 'FAILED',
        providerPaymentId: entity?.id || null,
        failureReason: reason.slice(0, 500),
        providerData: { ...(payment.providerData || {}), payment: auditEntity(entity) },
      },
    });
    if (count > 0) {
      await tx.subscription.updateMany({ where: { id: payment.subscriptionId, status: 'PENDING' }, data: { status: 'FAILED' } });
    }
    return count > 0;
  });
};

/* --------------------------------- Verify -------------------------------- */

const verifyPayment = async (userId, { razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature }) => {
  const payment = await prisma.payment.findFirst({ where: { providerOrderId: orderId, userId } });
  if (!payment) {
    throw notFound('Payment not found', 'PAYMENT_NOT_FOUND');
  }

  if (!razorpay.verifyPaymentSignature({ orderId, paymentId, signature })) {
    logger.warn({ userId, paymentId: payment.id }, 'invalid checkout signature');
    throw badRequest('Invalid payment signature', undefined, 'INVALID_PAYMENT_SIGNATURE');
  }

  if (payment.status === 'SUCCESS' && payment.providerPaymentId === paymentId) {
    const subscription = await prisma.subscription.findUnique({ where: { id: payment.subscriptionId }, include: { plan: true } });
    return { payment: publicPayment(payment), subscription: subscriptionsService.publicSubscription(subscription), alreadyProcessed: true };
  }
  if (payment.status === 'REFUNDED') {
    throw conflict('This payment was refunded', undefined, 'PAYMENT_REFUNDED');
  }

  // Never trust the client: ask Razorpay what actually happened.
  let entity = await razorpay.fetchPayment(paymentId);
  assertEntityMatchesPayment(payment, entity);

  if (entity.status === 'authorized') {
    entity = await razorpay.capturePayment(paymentId, payment.amount, payment.currency);
  }
  if (entity.status === 'failed') {
    await applyPaymentFailure(payment, entity);
    throw new AppError(402, 'PAYMENT_FAILED', 'Payment failed', { details: { reason: entity.error_description || entity.error_reason || null } });
  }
  if (entity.status !== 'captured') {
    throw conflict('Payment is not complete yet', { status: entity.status }, 'PAYMENT_NOT_CAPTURED');
  }

  const result = await applyPaymentSuccess(payment, entity, 'client_verify');
  return {
    payment: publicPayment(result.payment),
    subscription: subscriptionsService.publicSubscription(result.subscription),
    alreadyProcessed: result.alreadyProcessed,
  };
};

/* --------------------------------- Webhook ------------------------------- */

const recordEvent = async (eventId, eventType, payload) => {
  try {
    const event = await prisma.paymentWebhookEvent.create({ data: { provider: 'RAZORPAY', eventId, eventType, payload } });
    return { event, duplicate: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const event = await prisma.paymentWebhookEvent.findUnique({ where: { provider_eventId: { provider: 'RAZORPAY', eventId } } });
      // An event stored but not processed (crash / earlier failure) is processed again.
      return { event, duplicate: Boolean(event?.processedAt) };
    }
    throw error;
  }
};

const findPaymentForEntity = async (entity) => {
  if (entity?.order_id) {
    const byOrder = await prisma.payment.findUnique({ where: { providerOrderId: entity.order_id } });
    if (byOrder) return byOrder;
  }
  return null;
};

const processEvent = async (eventType, payload) => {
  const paymentEntity = payload?.payload?.payment?.entity;

  switch (eventType) {
    case 'payment.captured':
    case 'order.paid': {
      const payment = await findPaymentForEntity(paymentEntity);
      if (!payment) return 'ignored:unknown_order';
      assertEntityMatchesPayment(payment, paymentEntity);
      if (paymentEntity.status !== 'captured') return `ignored:status_${paymentEntity.status}`;
      const result = await applyPaymentSuccess(payment, paymentEntity, 'webhook');
      return result.alreadyProcessed ? 'already_processed' : 'activated';
    }
    case 'payment.authorized': {
      // Manual-capture accounts: capture so the money is not auto-refunded.
      const payment = await findPaymentForEntity(paymentEntity);
      if (!payment) return 'ignored:unknown_order';
      assertEntityMatchesPayment(payment, paymentEntity);
      if (payment.status === 'SUCCESS') return 'already_processed';
      try {
        const captured = await razorpay.capturePayment(paymentEntity.id, payment.amount, payment.currency);
        if (captured.status === 'captured') {
          await applyPaymentSuccess(payment, captured, 'webhook');
          return 'captured';
        }
      } catch (error) {
        logger.warn({ paymentId: payment.id, err: error.message }, 'capture from webhook failed; waiting for payment.captured');
      }
      return 'authorized';
    }
    case 'payment.failed': {
      const payment = await findPaymentForEntity(paymentEntity);
      if (!payment) return 'ignored:unknown_order';
      return (await applyPaymentFailure(payment, paymentEntity)) ? 'marked_failed' : 'ignored:not_pending';
    }
    case 'refund.processed':
    case 'payment.refunded': {
      const refund = payload?.payload?.refund?.entity;
      const providerPaymentId = refund?.payment_id || paymentEntity?.id;
      if (!providerPaymentId) return 'ignored:no_payment';
      const payment = await prisma.payment.findUnique({ where: { providerPaymentId } });
      if (!payment) return 'ignored:unknown_payment';
      const refundedTotal = paymentEntity?.amount_refunded ?? refund?.amount ?? 0;
      if (refundedTotal < payment.amount) return 'partial_refund';
      await prisma.$transaction(async (tx) => {
        await tx.payment.update({ where: { id: payment.id }, data: { status: 'REFUNDED', refundedAt: new Date() } });
        await tx.subscription.updateMany({
          where: { id: payment.subscriptionId, status: 'ACTIVE' },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
      });
      return 'refunded';
    }
    default:
      return 'ignored:event_type';
  }
};

/**
 * @param {Buffer} rawBody   exact request bytes (signature input)
 * @param {object} headers
 * @param {object} payload   parsed JSON
 */
const handleWebhook = async (rawBody, headers, payload) => {
  if (!razorpay.isWebhookConfigured()) {
    throw new AppError(503, 'WEBHOOK_NOT_CONFIGURED', 'Payment webhook is not configured on the server');
  }
  if (!rawBody || !razorpay.verifyWebhookSignature(rawBody, headers['x-razorpay-signature'])) {
    logger.warn('razorpay webhook rejected: invalid signature');
    throw new AppError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Invalid webhook signature');
  }

  const eventType = typeof payload?.event === 'string' ? payload.event : 'unknown';
  const eventId = String(headers['x-razorpay-event-id'] || '').trim() || `body:${createHash('sha256').update(rawBody).digest('hex')}`;

  const { event, duplicate } = await recordEvent(eventId, eventType, payload);
  if (duplicate) {
    return { received: true, duplicate: true };
  }

  let result;
  try {
    result = await processEvent(eventType, payload);
  } catch (error) {
    // Permanent problems (e.g. amount mismatch) are recorded and acknowledged so
    // Razorpay stops retrying; transient ones (5xx) propagate and get redelivered.
    if (!(error instanceof AppError) || error.statusCode >= 500) {
      throw error;
    }
    result = `rejected:${error.code}`;
  }
  await prisma.paymentWebhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), result } });
  logger.info({ eventType, eventId, result }, 'razorpay webhook processed');
  return { received: true, result };
};

/* --------------------------------- Queries ------------------------------- */

const listPayments = async (userId) => {
  const payments = await prisma.payment.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  return payments.map(publicPayment);
};

module.exports = { createPayment, verifyPayment, handleWebhook, listPayments, publicPayment, __testing: { processEvent, applyPaymentSuccess } };
