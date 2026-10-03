/**
 * One generic schedule for recurring verification. WEEKLY / MONTHLY / QUARTERLY
 * differ only in the period added here; everything else is shared.
 */

const { addDays, addMonths } = require('../../utils/dates');

const PERIODS = {
  WEEKLY: (from) => addDays(from, 7),
  MONTHLY: (from) => addMonths(from, 1),
  QUARTERLY: (from) => addMonths(from, 3),
};

const FREQUENCIES = Object.keys(PERIODS);

const nextVerificationDate = (frequency, from = new Date()) => {
  const period = PERIODS[frequency];
  if (!period) throw new Error(`Unknown verification frequency ${frequency}`);
  return period(from);
};

/** Delay before retrying a failed scheduled verification: 1h, 2h, 4h ... capped at 24h. */
const failureRetryDate = (consecutiveFailures, from = new Date()) => {
  const hours = Math.min(2 ** Math.max(consecutiveFailures - 1, 0), 24);
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
};

module.exports = { FREQUENCIES, nextVerificationDate, failureRetryDate };
