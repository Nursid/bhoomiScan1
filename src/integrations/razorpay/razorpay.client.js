/**
 * Razorpay REST client (Orders + Payments APIs) with Basic auth, plus signature
 * checks. Follows the reference backend's fetch + Basic auth approach
 * (server/razorpayClient.js) on top of the shared httpClient; no SDK needed.
 *
 * Signatures
 *   checkout:  HMAC_SHA256(order_id + "|" + payment_id, RAZORPAY_KEY_SECRET)
 *   webhook:   HMAC_SHA256(raw request body, RAZORPAY_WEBHOOK_SECRET)  (x-razorpay-signature)
 */

const { createHmac, timingSafeEqual } = require('crypto');
const config = require('../../config');
const { createHttpClient } = require('../../utils/httpClient');
const { ProviderError, AppError } = require('../../utils/errors');

const PROVIDER = 'RAZORPAY';

const isConfigured = () => Boolean(config.razorpay.keyId && config.razorpay.keySecret);
const isWebhookConfigured = () => Boolean(config.razorpay.webhookSecret);

const mapError = ({ status, body, timedOut, networkError }) => {
  if (timedOut) {
    return new ProviderError(504, 'PAYMENT_PROVIDER_TIMEOUT', 'Payment provider did not respond in time', { provider: PROVIDER, retryable: true });
  }
  if (networkError) {
    return new ProviderError(502, 'PAYMENT_PROVIDER_UNREACHABLE', 'Unable to reach the payment provider', {
      provider: PROVIDER,
      retryable: true,
      providerMessage: networkError.message,
    });
  }
  const providerMessage = body?.error?.description || body?.error?.reason || `http ${status}`;
  const common = { provider: PROVIDER, providerStatus: status, providerMessage, providerBody: body?.error };
  if (status === 401) {
    return new ProviderError(503, 'PAYMENT_PROVIDER_MISCONFIGURED', 'Payments are not configured correctly on the server', common);
  }
  if (status === 429) {
    return new ProviderError(429, 'PAYMENT_PROVIDER_RATE_LIMITED', 'Payment provider is busy, please retry shortly', { ...common, retryable: true, retryAfter: 5 });
  }
  if (status >= 500) {
    return new ProviderError(502, 'PAYMENT_PROVIDER_UNAVAILABLE', 'Payment provider is temporarily unavailable', { ...common, retryable: true });
  }
  return new ProviderError(502, 'PAYMENT_PROVIDER_REJECTED', 'Payment provider rejected the request', common);
};

const client = createHttpClient({
  provider: PROVIDER,
  baseUrl: () => config.razorpay.baseUrl,
  timeoutMs: () => config.razorpay.timeoutMs,
  headers: () => ({
    authorization: `Basic ${Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64')}`,
  }),
  mapError,
  extractReference: (body) => body?.id || null,
  // Keep audit rows small: ids, status and amounts only (no card/vpa/contact data).
  auditResponseBody: (body) => ({
    id: body?.id,
    entity: body?.entity,
    status: body?.status,
    amount: body?.amount,
    currency: body?.currency,
    order_id: body?.order_id,
    error: body?.error ? { code: body.error.code, description: body.error.description } : undefined,
  }),
});

const requireConfigured = () => {
  if (!isConfigured()) {
    throw new AppError(503, 'PAYMENTS_NOT_CONFIGURED', 'Payments are not configured on the server');
  }
};

const id = (value) => encodeURIComponent(String(value));

const createOrder = async ({ amount, currency, receipt, notes }) => {
  requireConfigured();
  const { body } = await client.post('/v1/orders', { amount, currency, receipt, notes: notes || {} }, { operation: 'order.create' });
  return body;
};

const fetchPayment = async (paymentId) => {
  requireConfigured();
  const { body } = await client.get(`/v1/payments/${id(paymentId)}`, { operation: 'payment.fetch', retries: 2 });
  return body;
};

const capturePayment = async (paymentId, amount, currency) => {
  requireConfigured();
  const { body } = await client.post(`/v1/payments/${id(paymentId)}/capture`, { amount, currency }, { operation: 'payment.capture' });
  return body;
};

const hmacHex = (secret, payload) => createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

const safeHexEqual = (expected, provided) => {
  if (typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

const verifyPaymentSignature = ({ orderId, paymentId, signature }) => {
  requireConfigured();
  return safeHexEqual(hmacHex(config.razorpay.keySecret, `${orderId}|${paymentId}`), signature);
};

/** @param {Buffer|string} rawBody exact bytes Razorpay sent */
const verifyWebhookSignature = (rawBody, signature) => {
  if (!isWebhookConfigured()) return false;
  const payload = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
  return safeHexEqual(hmacHex(config.razorpay.webhookSecret, payload), signature);
};

const getKeyId = () => config.razorpay.keyId;

module.exports = {
  isConfigured,
  isWebhookConfigured,
  getKeyId,
  createOrder,
  fetchPayment,
  capturePayment,
  verifyPaymentSignature,
  verifyWebhookSignature,
  __testing: { mapError, hmacHex },
};
