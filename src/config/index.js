/**
 * Central configuration. Every value comes from the environment (see .env.example);
 * nothing secret has a default. Integrations whose credentials are missing stay
 * disabled and answer 503 instead of crashing the process (same approach as the
 * reference backend's `isConfigured()` checks).
 */

const path = require('path');
const { z } = require('zod');

// dotenv never overrides variables the platform already set (e.g. Catalyst AppSail
// console variables); .env only fills in what is missing.
const DATABASE_URL_FROM_PLATFORM = Boolean(process.env.DATABASE_URL);
require('dotenv').config({ path: process.env.DOTENV_PATH || path.resolve(process.cwd(), '.env') });

const bool = (fallback) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())));

const int = (fallback, { min = 0 } = {}) =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined || value === '' ? fallback : Number(value)))
    .pipe(z.number().int().min(min));

const str = (fallback = '') =>
  z
    .string()
    .optional()
    .transform((value) => (value === undefined ? fallback : value.trim()));

const list = () =>
  z
    .string()
    .optional()
    .transform((value) =>
      (value || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
    );

const oneOf = (values, fallback) => z.preprocess((value) => (value === '' ? undefined : value), z.enum(values).default(fallback));

const url = (fallback) => str(fallback).transform((value) => value.replace(/\/+$/, ''));

const schema = z.object({
  NODE_ENV: oneOf(['development', 'test', 'production'], 'development'),
  PORT: z
  .preprocess(
    () => process.env.X_ZOHO_CATALYST_LISTEN_PORT || process.env.PORT || '4000',
    z.string()
  )
  .transform(Number)
  .pipe(z.number().int().min(0)),
  HOST: str('0.0.0.0'),
  LOG_LEVEL: str('info'),
  CORS_ORIGINS: list(),
  TRUST_PROXY: str('false'),
  API_DOCS_ENABLED: bool(true),

  DATABASE_URL: str(''),
  REDIS_URL: str(''),
  METADATA_CACHE_TTL_SECONDS: int(86400),

  JWT_SECRET: str(''),
  JWT_EXPIRES_IN: str('7d'),
  JWT_ISSUER: str('bhoomiscan-api'),

  MOBILE_DEFAULT_COUNTRY_CODE: str('91'),
  MSG91_WIDGET_ID: str(''),
  MSG91_TOKEN_AUTH: str(''),
  MSG91_AUTH_KEY: str(''),
  MSG91_BASE_URL: url('https://control.msg91.com'),
  MSG91_TIMEOUT_MS: int(15000, { min: 1000 }),
  MSG91_DEBUG_VERIFY_RESPONSE: bool(false),

  RAZORPAY_BASE_URL: url('https://api.razorpay.com'),
  RAZORPAY_KEY_ID: str(''),
  RAZORPAY_KEY_SECRET: str(''),
  RAZORPAY_WEBHOOK_SECRET: str(''),
  RAZORPAY_TIMEOUT_MS: int(20000, { min: 1000 }),

  SUREPASS_BASE_URL: url('https://sandbox.surepass.io'),
  SUREPASS_TOKEN: str(''),
  // Alias accepted for SUREPASS_TOKEN; SUREPASS_TOKEN wins when both are set.
  SUREPASS_API_TOKEN: str(''),
  SUREPASS_TIMEOUT_MS: int(30000, { min: 1000 }),
  SUREPASS_METADATA_RETRIES: int(2),
  SUREPASS_VERIFY_RETRIES: int(0),

  LAND_DIFF_IGNORED_FIELDS: list(),
  LAND_DIFF_USE_DEFAULT_IGNORES: bool(true),

  SMART_CONTRACT_PROVIDER: oneOf(['http', 'bsc', 'disabled'], 'disabled'),
  SMART_CONTRACT_API_URL: url(''),
  SMART_CONTRACT_API_KEY: str(''),
  SMART_CONTRACT_STORE_PATH: str('/records'),
  SMART_CONTRACT_TIMEOUT_MS: int(30000, { min: 1000 }),
  SMART_CONTRACT_MAX_ATTEMPTS: int(8, { min: 1 }),
  SMART_CONTRACT_INLINE_SUBMIT: bool(true),
  BSC_RPC_URL: str('https://data-seed-prebsc-1-s1.binance.org:8545/'),
  BSC_CHAIN_ID: int(97),
  BSC_EXPLORER_TX_URL: str(''),
  LAND_VERIFICATION_CONTRACT_ADDRESS: str(''),
  OPERATOR_PRIVATE_KEY: str(''),

  JOBS_ENABLED: bool(true),
  JOB_RECURRING_VERIFICATION_INTERVAL_SECONDS: int(300, { min: 5 }),
  JOB_SMART_CONTRACT_RETRY_INTERVAL_SECONDS: int(60, { min: 5 }),
  JOB_SUBSCRIPTION_EXPIRY_INTERVAL_SECONDS: int(300, { min: 5 }),
  JOB_BATCH_SIZE: int(20, { min: 1 }),

  RATE_LIMIT_WINDOW_SECONDS: int(60, { min: 1 }),
  RATE_LIMIT_GLOBAL_MAX: int(300, { min: 1 }),
  RATE_LIMIT_OTP_VERIFY_MAX: int(10, { min: 1 }),
  RATE_LIMIT_LAND_VERIFY_MAX: int(20, { min: 1 }),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
  throw new Error(`Invalid environment configuration: ${problems}`);
}
const env = parsed.data;

const MIN_JWT_SECRET_LENGTH = 32;

if (env.NODE_ENV === 'production') {
  if (env.JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters in production`);
  }
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required in production');
  }
}

const trustProxy = (() => {
  const value = env.TRUST_PROXY.toLowerCase();
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  return /^\d+$/.test(value) ? Number(value) : env.TRUST_PROXY;
})();

const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',
  port: env.PORT,
  host: env.HOST,
  logLevel: env.LOG_LEVEL,
  // Tolerates values pasted into a hosting console with quotes or a trailing slash.
  corsOrigins: env.CORS_ORIGINS.map((origin) => origin.replace(/^["']+|["']+$/g, '').replace(/\/+$/, '').toLowerCase()).filter(Boolean),
  trustProxy,
  apiDocsEnabled: env.API_DOCS_ENABLED,

  databaseUrl: env.DATABASE_URL,
  databaseUrlSource: DATABASE_URL_FROM_PLATFORM ? 'environment' : env.DATABASE_URL ? '.env file' : 'missing',
  redisUrl: env.REDIS_URL,
  metadataCacheTtlSeconds: env.METADATA_CACHE_TTL_SECONDS,

  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN,
    issuer: env.JWT_ISSUER,
    isConfigured: env.JWT_SECRET.length >= MIN_JWT_SECRET_LENGTH,
    minSecretLength: MIN_JWT_SECRET_LENGTH,
  },

  otp: {
    defaultCountryCode: env.MOBILE_DEFAULT_COUNTRY_CODE.replace(/\D/g, '') || '91',
  },

  msg91: {
    widgetId: env.MSG91_WIDGET_ID,
    tokenAuth: env.MSG91_TOKEN_AUTH,
    authKey: env.MSG91_AUTH_KEY,
    baseUrl: env.MSG91_BASE_URL,
    timeoutMs: env.MSG91_TIMEOUT_MS,
    debugResponses: env.MSG91_DEBUG_VERIFY_RESPONSE,
  },

  razorpay: {
    baseUrl: env.RAZORPAY_BASE_URL,
    keyId: env.RAZORPAY_KEY_ID,
    keySecret: env.RAZORPAY_KEY_SECRET,
    webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
    timeoutMs: env.RAZORPAY_TIMEOUT_MS,
  },

  surepass: {
    baseUrl: env.SUREPASS_BASE_URL,
    token: env.SUREPASS_TOKEN || env.SUREPASS_API_TOKEN,
    timeoutMs: env.SUREPASS_TIMEOUT_MS,
    metadataRetries: env.SUREPASS_METADATA_RETRIES,
    verifyRetries: env.SUREPASS_VERIFY_RETRIES,
  },

  landDiff: {
    ignoredFields: env.LAND_DIFF_IGNORED_FIELDS,
    useDefaultIgnores: env.LAND_DIFF_USE_DEFAULT_IGNORES,
  },

  smartContract: {
    provider: env.SMART_CONTRACT_PROVIDER,
    apiUrl: env.SMART_CONTRACT_API_URL,
    apiKey: env.SMART_CONTRACT_API_KEY,
    storePath: env.SMART_CONTRACT_STORE_PATH.startsWith('/') ? env.SMART_CONTRACT_STORE_PATH : `/${env.SMART_CONTRACT_STORE_PATH}`,
    timeoutMs: env.SMART_CONTRACT_TIMEOUT_MS,
    maxAttempts: env.SMART_CONTRACT_MAX_ATTEMPTS,
    inlineSubmit: env.SMART_CONTRACT_INLINE_SUBMIT,
    bsc: {
      rpcUrl: env.BSC_RPC_URL,
      chainId: env.BSC_CHAIN_ID,
      explorerTxUrl: env.BSC_EXPLORER_TX_URL || (env.BSC_CHAIN_ID === 56 ? 'https://bscscan.com/tx/' : 'https://testnet.bscscan.com/tx/'),
      contractAddress: env.LAND_VERIFICATION_CONTRACT_ADDRESS,
      privateKey: env.OPERATOR_PRIVATE_KEY,
    },
  },

  jobs: {
    enabled: env.JOBS_ENABLED,
    recurringVerificationIntervalSeconds: env.JOB_RECURRING_VERIFICATION_INTERVAL_SECONDS,
    smartContractRetryIntervalSeconds: env.JOB_SMART_CONTRACT_RETRY_INTERVAL_SECONDS,
    subscriptionExpiryIntervalSeconds: env.JOB_SUBSCRIPTION_EXPIRY_INTERVAL_SECONDS,
    batchSize: env.JOB_BATCH_SIZE,
  },

  rateLimit: {
    windowMs: env.RATE_LIMIT_WINDOW_SECONDS * 1000,
    globalMax: env.RATE_LIMIT_GLOBAL_MAX,
    otpVerifyMax: env.RATE_LIMIT_OTP_VERIFY_MAX,
    landVerifyMax: env.RATE_LIMIT_LAND_VERIFY_MAX,
  },
};

module.exports = config;
