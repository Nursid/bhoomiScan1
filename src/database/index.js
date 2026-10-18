/**
 * Application database access (Catalyst Data Store + claim registry).
 *
 *   const db = require('../../database');
 *   await db.users.findOne({ mobile });
 *   const { won } = await db.claims.claim(db.keys.userByMobile(mobile), newId);
 *
 * Repositories are per table (see src/database/catalyst/datastore.js). Anything that must
 * happen at most once, or be unique, goes through db.claims with a key from db.keys.
 */

const { table } = require('./catalyst/datastore');
const { createHash } = require('crypto');
const claims = require('./catalyst/registry');

/** Values that may contain characters not allowed in claim keys are hashed. */
const safe = (value) => (/^[A-Za-z0-9:_.+@|-]{1,200}$/.test(String(value)) ? String(value) : `h${createHash('sha256').update(String(value)).digest('hex')}`);

const db = {
  users: table('users'),
  subscriptionPlans: table('subscription_plans'),
  subscriptions: table('subscriptions'),
  payments: table('payments'),
  paymentWebhookEvents: table('payment_webhook_events'),
  landVerifications: table('land_verifications'),
  landRecordSnapshots: table('land_record_snapshots'),
  landRecordChanges: table('land_record_changes'),
  smartContractRecords: table('smart_contract_records'),
  uploadedDocuments: table('uploaded_documents'),
  alerts: table('alerts'),
  apiRequestLogs: table('api_request_logs'),
  deviceTokens: table('device_tokens'),
  notifications: table('notifications'),

  claims,

  /**
   * Claim keys. Deterministic, built only from stable business identifiers, and scoped by
   * purpose so different uses can never collide. The NoSQL table is per Catalyst
   * environment, so Development and Production keys never meet.
   */
  keys: {
    userByMobile: (e164) => `user:mobile:${e164}`,
    userByFirebaseUid: (uid) => `user:firebase:${safe(uid)}`,
    planByCode: (code) => `plan:code:${code}`,
    webhookEvent: (provider, eventId) => `webhook:${provider}:${eventId}`,
    paymentOrder: (orderId) => `payment:order:${orderId}`,
    paymentProviderPayment: (providerPaymentId) => `payment:provider:${providerPaymentId}`,
    paymentSuccess: (paymentId) => `payment:success:${paymentId}`,
    pendingSubscription: (userId, planId, seq) => `subscription:pending:${userId}:${planId}:${seq}`,
    subscriptionChain: (userId, previousId) => `subscription:chain:${userId}:${previousId || 'root'}`,
    landParcel: (userId, stateCode, parcelKey) => `land:${userId}:${stateCode}:${parcelKey}`,
    snapshotSequence: (landVerificationId, sequence) => `snapshot:${landVerificationId}:${sequence}`,
    smartContractForSnapshot: (snapshotId) => `sc:snapshot:${snapshotId}`,
    jobAttempt: (kind, id, attempt) => `job:${kind}:${id}:${attempt}`,
    deviceToken: (tokenSha256) => `device:${tokenSha256}`,
    documentHash: (userId, dataHash) => `document:hash:${userId}:${dataHash}`,
    documentVersion: (userId, seriesId, version) => `document:version:${userId}:${seriesId}:${version}`,
    documentStorageKey: (key) => `document:storage:${safe(key)}`,
    adminEmail: (email) => `admin:email:${safe(email.toLowerCase())}`,
  },
};

module.exports = db;
