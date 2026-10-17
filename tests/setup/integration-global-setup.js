// Applies migrations to the test database once per run.
const { execSync } = require('child_process');
const path = require('path');
const { requireTestDatabaseUrl } = require('./test-database-url');

module.exports = async () => {
  const url = requireTestDatabaseUrl();
  const options = {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  };
  execSync('npx prisma migrate deploy', options);
  // migrate deploy does not regenerate the client after schema/model changes.
  execSync('npx prisma generate', options);
};
