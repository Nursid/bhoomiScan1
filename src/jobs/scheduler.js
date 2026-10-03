/**
 * Minimal in-process job scheduler. Each job runs on its own interval, never
 * overlaps with itself, and is safe to run on several instances at once (the
 * jobs claim rows in the database). Jobs are plain async functions, so moving
 * them to BullMQ/cron later only means calling the same functions from there.
 */

const config = require('../config');
const logger = require('../utils/logger');
const recurringVerification = require('./recurring-verification.job');
const smartContractService = require('../modules/smart-contract/smart-contract.service');
const subscriptionsService = require('../modules/subscriptions/subscriptions.service');

const JOBS = [
  { name: 'subscription-expiry', everySeconds: () => config.jobs.subscriptionExpiryIntervalSeconds, run: () => subscriptionsService.expireDueSubscriptions() },
  { name: 'smart-contract-retry', everySeconds: () => config.jobs.smartContractRetryIntervalSeconds, run: () => smartContractService.processDueRecords() },
  { name: 'recurring-verification', everySeconds: () => config.jobs.recurringVerificationIntervalSeconds, run: () => recurringVerification.run() },
];

const timers = [];
const running = new Set();

const tick = async (job) => {
  if (running.has(job.name)) return;
  running.add(job.name);
  try {
    await job.run();
  } catch (error) {
    logger.error({ job: job.name, err: error }, 'job failed');
  } finally {
    running.delete(job.name);
  }
};

const start = () => {
  JOBS.forEach((job, index) => {
    // Stagger first runs so a restart does not fire everything at once.
    timers.push(setTimeout(() => tick(job), 5000 + index * 2000));
    timers.push(setInterval(() => tick(job), job.everySeconds() * 1000));
  });
  logger.info({ jobs: JOBS.map((job) => `${job.name}@${job.everySeconds()}s`) }, 'job scheduler started');
};

const stop = async () => {
  timers.splice(0).forEach((timer) => {
    clearTimeout(timer);
    clearInterval(timer);
  });
  // Let in-flight jobs finish (bounded).
  const deadline = Date.now() + 15000;
  while (running.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
};

module.exports = { start, stop, JOBS, tick };
