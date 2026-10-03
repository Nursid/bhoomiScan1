// Applies migrations to the test database once per run.
const { execSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  const url = process.env.TEST_DATABASE_URL || 'postgresql://bhoomiscan:bhoomiscan@localhost:5436/bhoomiscan_test?schema=public';
  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(__dirname, '..', '..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
};
