jest.mock('child_process', () => ({ execSync: jest.fn() }));

const { execSync } = require('child_process');
const { requireTestDatabaseUrl } = require('../setup/test-database-url');
const migrateTestDatabase = require('../setup/integration-global-setup');

const testUrl = 'postgresql://test_role:fake%40password@ep-test.example.neon.tech:5432/bhoomiscan_test?sslmode=require&schema=public';

describe('integration database safety guard', () => {
  beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env, DATABASE_URL: 'postgresql://app:fake@app.example/application' });
    delete process.env.TEST_DATABASE_URL;
    execSync.mockReset();
  });
  afterEach(() => jest.restoreAllMocks());

  test.each([undefined, '', '   '])('rejects a missing test URL (%p) without using DATABASE_URL', (value) => {
    expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: value, DATABASE_URL: testUrl })).toThrow('explicit TEST_DATABASE_URL');
  });

  test.each([
    'not-a-url',
    'https://test.example/bhoomiscan_test',
    'postgresql:///bhoomiscan_test',
    'postgresql://test:fake@localhost:invalid/bhoomiscan_test',
    'postgresql://test:fake%ZZ@localhost/bhoomiscan_test',
    'postgresql://test:fake@local\nhost/bhoomiscan_test',
    `${testUrl}#fragment`,
  ])('rejects a malformed or non-PostgreSQL URL (%p)', (value) => {
    expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: value })).toThrow('bhoomiscan_test');
  });

  test.each(['neondb', 'bhoomiscan', 'bhoomiscan_test_extra', 'bhoomiscan_test/other', ''])('rejects database name %p', (database) => {
    expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: `postgresql://test:fake@localhost/${database}` })).toThrow('bhoomiscan_test');
  });

  test('accepts the explicit Neon test URL and preserves TLS/schema parameters', () => {
    expect(requireTestDatabaseUrl({ TEST_DATABASE_URL: testUrl })).toBe(testUrl);
    expect(requireTestDatabaseUrl({ TEST_DATABASE_URL: 'postgres://localhost/bhoomiscan_test' }))
      .toBe('postgres://localhost/bhoomiscan_test');
  });

  test.each([
    'bad%20host', 'bad%2Fhost', 'bad%40host', 'bad%00host', '%65p-test.example.neon.tech',
    '-bad.example', 'bad-.example', 'bad..example', 'bad_host.example', '999.999.999.999',
  ])('rejects invalid or encoded hostname %p', (host) => {
    expect(() => requireTestDatabaseUrl({ TEST_DATABASE_URL: `postgresql://test:fake@${host}/bhoomiscan_test` }))
      .toThrow('explicit TEST_DATABASE_URL');
  });

  test.each([
    'postgresql://test:fake%40password@ep-test.example.neon.tech:5432/bhoomiscan_test?sslmode=require&schema=public',
    'postgres://localhost/bhoomiscan_test',
    'postgresql://127.0.0.1:5436/bhoomiscan_test',
    'postgresql://[::1]:5436/bhoomiscan_test',
    'postgresql://[2001:db8::1]/bhoomiscan_test',
  ])('preserves valid PostgreSQL URL %p', (value) => {
    expect(requireTestDatabaseUrl({ TEST_DATABASE_URL: value })).toBe(value);
  });

  test('does not include credentials or connection strings in validation errors', () => {
    const secretUrl = 'postgresql://private_user:private_password@private.example/application';
    try {
      requireTestDatabaseUrl({ TEST_DATABASE_URL: secretUrl });
      throw new Error('Expected rejection');
    } catch (error) {
      expect(error.message).toContain('explicit TEST_DATABASE_URL');
      for (const secret of [secretUrl, 'private_user', 'private_password', 'private.example']) {
        expect(error.message).not.toContain(secret);
      }
    }
  });

  test.each([undefined, 'bad-url', 'postgresql://test:fake@localhost/application', 'postgresql://bad%20host/bhoomiscan_test'])('blocks migration execution for unsafe configuration (%p)', async (value) => {
    if (value !== undefined) process.env.TEST_DATABASE_URL = value;
    await expect(migrateTestDatabase()).rejects.toThrow('explicit TEST_DATABASE_URL');
    expect(execSync).not.toHaveBeenCalled();
  });

  test('migrates then regenerates the client using only the validated test URL', async () => {
    process.env.TEST_DATABASE_URL = testUrl;
    const applicationUrl = process.env.DATABASE_URL;
    await migrateTestDatabase();
    expect(execSync.mock.calls.map(([command]) => command)).toEqual(['npx prisma migrate deploy', 'npx prisma generate']);
    for (const [, options] of execSync.mock.calls) {
      expect(options.env).toEqual(expect.objectContaining({ DATABASE_URL: testUrl, TEST_DATABASE_URL: testUrl }));
    }
    expect(process.env.DATABASE_URL).toBe(applicationUrl);
  });

  test.each(['postgresql://test:fake@localhost/application', 'postgresql://bad%20host/bhoomiscan_test'])('rejects unsafe worker setup before changing its DATABASE_URL (%p)', (value) => {
    process.env.TEST_DATABASE_URL = value;
    const applicationUrl = process.env.DATABASE_URL;
    expect(() => jest.isolateModules(() => require('../setup/integration-env'))).toThrow('explicit TEST_DATABASE_URL');
    expect(process.env.DATABASE_URL).toBe(applicationUrl);
  });

  test('uses the explicit test URL inside a worker and disables .env loading', () => {
    process.env.TEST_DATABASE_URL = testUrl;
    jest.isolateModules(() => require('../setup/integration-env'));
    expect(process.env.DATABASE_URL).toBe(testUrl);
    expect(process.env.DOTENV_PATH).toBe('/nonexistent/.env');
    expect(process.env.SMART_CONTRACT_PROVIDER).toBe('http');
    expect(process.env.JOBS_ENABLED).toBe('false');
  });
});
