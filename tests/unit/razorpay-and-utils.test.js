const { createHmac } = require('crypto');
const razorpay = require('../../src/integrations/razorpay/razorpay.client');
const { normalizeMobile } = require('../../src/utils/mobile');
const { addMonths } = require('../../src/utils/dates');
const { nextVerificationDate, failureRetryDate } = require('../../src/modules/land-verification/verification-schedule');
const { canonicalStringify, hashCanonical } = require('../../src/utils/canonicalJson');
const { sanitize } = require('../../src/utils/sanitize');
const tokens = require('../../src/modules/auth/token.service');

describe('razorpay signatures', () => {
  test('checkout signature = HMAC(order|payment, key secret)', () => {
    const signature = createHmac('sha256', 'rzp-unit-secret').update('order_ABC123|pay_XYZ789').digest('hex');
    expect(razorpay.verifyPaymentSignature({ orderId: 'order_ABC123', paymentId: 'pay_XYZ789', signature })).toBe(true);
    expect(razorpay.verifyPaymentSignature({ orderId: 'order_ABC123', paymentId: 'pay_OTHER', signature })).toBe(false);
    expect(razorpay.verifyPaymentSignature({ orderId: 'order_ABC123', paymentId: 'pay_XYZ789', signature: 'x' })).toBe(false);
  });

  test('webhook signature over the raw body', () => {
    const raw = Buffer.from('{"event":"payment.captured"}');
    const signature = createHmac('sha256', 'rzp-unit-webhook-secret').update(raw).digest('hex');
    expect(razorpay.verifyWebhookSignature(raw, signature)).toBe(true);
    expect(razorpay.verifyWebhookSignature(Buffer.from('{"event":"payment.captured" }'), signature)).toBe(false);
    expect(razorpay.verifyWebhookSignature(raw, undefined)).toBe(false);
  });

  test('401 from Razorpay is a server configuration problem (503)', () => {
    expect(razorpay.__testing.mapError({ status: 401, body: { error: { description: 'bad key' } } })).toMatchObject({ statusCode: 503 });
  });
});

describe('normalizeMobile', () => {
  test.each(['7081002501', '07081002501', '917081002501', '+91 70810 02501', '0091-7081002501'])('%s -> +917081002501', (input) => {
    expect(normalizeMobile(input).e164).toBe('+917081002501');
  });
  test.each(['12345', '5081002501', 'abc', '', null])('rejects %s', (input) => expect(normalizeMobile(input)).toBeNull());
});

describe('dates and schedules', () => {
  test('addMonths clamps month ends', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe('2026-02-28T10:00:00.000Z');
    expect(addMonths(new Date('2026-11-30T00:00:00Z'), 3).toISOString()).toBe('2027-02-28T00:00:00.000Z');
  });
  test('one generic schedule for all frequencies', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    expect(nextVerificationDate('WEEKLY', from).toISOString()).toBe('2026-10-08T00:00:00.000Z');
    expect(nextVerificationDate('MONTHLY', from).toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(nextVerificationDate('QUARTERLY', from).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(() => nextVerificationDate('DAILY', from)).toThrow();
  });
  test('failure backoff grows and caps at 24h', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    expect(failureRetryDate(1, from).getTime() - from.getTime()).toBe(3600_000);
    expect(failureRetryDate(3, from).getTime() - from.getTime()).toBe(4 * 3600_000);
    expect(failureRetryDate(20, from).getTime() - from.getTime()).toBe(24 * 3600_000);
  });
});

describe('canonical JSON', () => {
  test('key order does not change output or hash', () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(hashCanonical({ b: 1, a: 2 })).toBe(hashCanonical({ a: 2, b: 1 }));
  });
});

describe('sanitize', () => {
  test('redacts secrets at any depth', () => {
    expect(sanitize({ otp: '1234', nested: { Authorization: 'Bearer x', ok: 1 }, list: [{ token: 't' }] })).toEqual({
      otp: '[REDACTED]',
      nested: { Authorization: '[REDACTED]', ok: 1 },
      list: [{ token: '[REDACTED]' }],
    });
  });
});

describe('JWT', () => {
  test('round trip and tamper detection', () => {
    const { token } = tokens.generateToken({ id: '11111111-1111-1111-1111-111111111111', mobile: '+917081002501', role: 'USER' });
    expect(tokens.verifyToken(token).sub).toBe('11111111-1111-1111-1111-111111111111');
    expect(() => tokens.verifyToken(`${token}x`)).toThrow(expect.objectContaining({ statusCode: 401, code: 'INVALID_TOKEN' }));
    expect(tokens.readBearerToken({ authorization: `Bearer ${token}` })).toBe(token);
    expect(tokens.readBearerToken({})).toBeNull();
  });
});
