/**
 * Live Surepass check: calls the REAL Surepass API (SUREPASS_BASE_URL +
 * SUREPASS_TOKEN from .env) through the same adapters the API uses, for every
 * registered state.
 *
 *   node scripts/surepass-live-check.js                    all states, metadata lists only
 *   node scripts/surepass-live-check.js --verify           also one verify call per state (BILLABLE)
 *   node scripts/surepass-live-check.js goa tripura        only these states
 *
 * Each list is requested with the documented sample values; the report shows
 * whether the call worked, how many options came back, and whether the sample
 * value used for the next level is among them. Land-record contents are never
 * printed, only the top-level field names of the verify response.
 */

const config = require('../src/config');
const registry = require('../src/modules/land-verification/providers/registry');
const SAMPLES = require('./surepass-samples');

const args = process.argv.slice(2);
const withVerify = args.includes('--verify');
const only = args.filter((arg) => !arg.startsWith('--'));

const describeError = (error) => {
  const parts = [error.code || error.name, error.statusCode && `http ${error.statusCode}`, error.providerStatus && `surepass ${error.providerStatus}`];
  const message = error.details?.providerMessage || error.providerMessage || error.message;
  return `${parts.filter(Boolean).join(' / ')}: ${message}`;
};

const timed = async (fn) => {
  const started = Date.now();
  try {
    return { ok: true, value: await fn(), ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error, ms: Date.now() - started };
  }
};

const checkState = async (adapter) => {
  const sample = SAMPLES[adapter.slug];
  const rows = [];
  if (!sample) return [{ call: '-', result: 'SKIP', detail: 'no sample locator' }];

  for (const field of adapter.fields) {
    if (!field.source) continue;
    const level = field.source;
    const filters = Object.fromEntries(adapter.metadataLevels[level].filters.map((name) => [name, sample[name]]));
    const outcome = await timed(() => adapter.listOptions(level, filters));
    if (!outcome.ok) {
      rows.push({ call: level, result: 'FAIL', ms: outcome.ms, detail: describeError(outcome.error) });
      continue;
    }
    const options = outcome.value;
    const wanted = String(sample[field.name]).toLowerCase();
    const found = options.some((o) => o.value.toLowerCase() === wanted || o.label.toLowerCase() === wanted);
    const preview = options.slice(0, 3).map((o) => o.value).join(' | ');
    rows.push({
      call: level,
      result: options.length === 0 ? 'EMPTY' : 'OK',
      ms: outcome.ms,
      detail: `${options.length} option(s); sample "${sample[field.name]}" ${found ? 'present' : 'NOT in list'}; e.g. ${preview}`,
    });
  }

  if (withVerify) {
    const parsed = adapter.locatorSchema.safeParse(sample);
    if (!parsed.success) {
      rows.push({ call: 'verify', result: 'FAIL', detail: `local validation: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}` });
    } else {
      const outcome = await timed(() => adapter.fetchRecord(parsed.data));
      rows.push(
        outcome.ok
          ? { call: 'verify', result: 'OK', ms: outcome.ms, detail: `fields: ${Object.keys(outcome.value.record || {}).slice(0, 12).join(', ')}` }
          : { call: 'verify', result: 'FAIL', ms: outcome.ms, detail: describeError(outcome.error) },
      );
    }
  }
  return rows;
};

const main = async () => {
  if (!config.surepass.token) {
    console.error('SUREPASS_TOKEN is not set (.env). Nothing was called.');
    process.exit(2);
  }
  console.log(`Surepass: ${config.surepass.baseUrl}   verify calls: ${withVerify ? 'YES (billable)' : 'no (pass --verify)'}\n`);

  const states = registry.listStates().filter((s) => only.length === 0 || only.includes(s.slug));
  const summary = [];
  for (const state of states) {
    const rows = await checkState(registry.getAdapter(state.slug));
    console.log(`== ${state.label} (${state.slug})`);
    for (const row of rows) console.log(`   ${row.result.padEnd(5)} ${row.call.padEnd(20)} ${String(row.ms ?? '').padStart(6)}ms  ${row.detail}`);
    summary.push({ state: state.slug, ok: rows.filter((r) => r.result === 'OK').length, total: rows.length });
  }

  console.log('\nSummary');
  for (const s of summary) console.log(`   ${s.ok === s.total ? 'PASS' : 'FAIL'}  ${s.state.padEnd(22)} ${s.ok}/${s.total}`);
  process.exit(summary.every((s) => s.ok === s.total) ? 0 : 1);
};

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
