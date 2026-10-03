/** Calendar helpers (UTC). addMonths clamps to the last day of the target month. */

const addDays = (date, days) => new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

const addMonths = (date, months) => {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
};

const addSeconds = (date, seconds) => new Date(date.getTime() + seconds * 1000);

const fromUnixSeconds = (seconds) =>
  typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000) : null;

module.exports = { addDays, addMonths, addSeconds, fromUnixSeconds };
