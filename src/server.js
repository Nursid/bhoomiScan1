/** Process entry: HTTP server + (optionally) background jobs, graceful shutdown. */

const config = require('./config');
const logger = require('./utils/logger');
const { createApp } = require('./app');
const { prisma, disconnect } = require('./database/prisma');
const { describeDatabaseUrl, describeDbError } = require('./database/diagnostics');
const cache = require('./utils/cache');
const scheduler = require('./jobs/scheduler');
const msg91 = require('./integrations/msg91/msg91.client');
const razorpay = require('./integrations/razorpay/razorpay.client');
const surepass = require('./integrations/surepass/surepass.client');
const { getSmartContractProvider } = require('./integrations/smart-contract');

const app = createApp();
const server = app.listen(config.port, config.host, () => {
  const smartContract = getSmartContractProvider();
  logger.info(
    {
      port: config.port,
      env: config.env,
      readiness: {
        jwt: config.jwt.isConfigured,
        msg91: msg91.isConfigured(),
        razorpay: razorpay.isConfigured(),
        razorpayWebhook: razorpay.isWebhookConfigured(),
        surepass: surepass.isConfigured(),
        smartContract: `${smartContract.name}:${smartContract.isConfigured()}`,
        cache: config.redisUrl ? 'redis' : 'memory',
        jobs: config.jobs.enabled,
      },
      corsOrigins: config.corsOrigins,
    },
    'BhoomiScan API listening',
  );
  if (config.jobs.enabled) scheduler.start();
  checkDatabase();
});

// Non-fatal startup probe: logs the real (sanitized) cause if Prisma cannot reach the database.
const checkDatabase = async () => {
  const database = describeDatabaseUrl();
  const runtime = { platform: process.platform, arch: process.arch, node: process.version };
  try {
    await prisma.$queryRaw`SELECT 1`;
    logger.info({ database, runtime }, 'database connection ok');
  } catch (err) {
    logger.error({ dbError: describeDbError(err), database, runtime }, 'database connection failed');
  }
};

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  server.close();
  await scheduler.stop();
  await cache.close();
  await disconnect();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error({ err: reason }, 'unhandled rejection'));
