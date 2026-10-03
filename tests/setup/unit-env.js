// Unit tests: no database, no .env file, deterministic config.
Object.assign(process.env, {
  NODE_ENV: 'test',
  DOTENV_PATH: '/nonexistent/.env',
  DATABASE_URL: '',
  JWT_SECRET: 'unit-test-secret-that-is-definitely-longer-than-32-chars',
  SUREPASS_BASE_URL: 'https://sandbox.surepass.test',
  SUREPASS_TOKEN: 'surepass-test-token',
  SUREPASS_METADATA_RETRIES: '2',
  SUREPASS_VERIFY_RETRIES: '0',
  SUREPASS_TIMEOUT_MS: '1000',
  RAZORPAY_KEY_ID: 'rzp_test_unit',
  RAZORPAY_KEY_SECRET: 'rzp-unit-secret',
  RAZORPAY_WEBHOOK_SECRET: 'rzp-unit-webhook-secret',
  OTP_PROVIDER: 'mock',
  OTP_MOCK_CODE: '123456',
});
