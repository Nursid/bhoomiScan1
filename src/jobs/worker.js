/** Standalone job worker: `npm run worker` (use with JOBS_ENABLED=false on API instances). */

const logger = require('../utils/logger');
const scheduler = require('./scheduler');
const { disconnect } = require('../database/prisma');
const cache = require('../utils/cache');

scheduler.start();

const shutdown = async (signal) => {
  logger.info({ signal }, 'worker shutting down');
  await scheduler.stop();
  await cache.close();
  await disconnect();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
