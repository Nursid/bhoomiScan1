/**
 * Creates the BhoomiScan tables in Catalyst Data Store from src/database/catalyst/schema.js.
 *
 *   node scripts/catalyst/provision.js                      # dry run, Development
 *   node scripts/catalyst/provision.js --apply              # create missing tables/columns in Development
 *   node scripts/catalyst/provision.js --env Production --apply --i-understand-production
 *
 * Idempotent and additive only: it creates missing tables and columns, never drops or
 * alters anything. Existing columns that differ from the spec (type, length, unique,
 * mandatory) are reported as drift; IsUnique cannot be changed after creation in
 * Catalyst, so drift must be resolved by hand.
 *
 * The NoSQL lock table (`bhoomi_locks`, partition key `lock_key` String, TTL `expires_at`)
 * cannot be created through the API and must exist in each environment (console).
 */

const { buildSpec } = require('../../src/database/catalyst/schema');
const { request } = require('../../src/database/catalyst/client');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
};
const environment = arg('--env') || 'Development';
const apply = process.argv.includes('--apply');

const columnBody = (column) => ({
  column_name: column.name,
  data_type: column.type,
  ...(column.type === 'varchar' ? { max_length: column.maxLength } : {}),
  is_unique: Boolean(column.dbUnique),
  is_mandatory: Boolean(column.mandatory),
});

const drift = (column, existing) => {
  const problems = [];
  if (existing.data_type !== column.type) problems.push(`type ${existing.data_type} != ${column.type}`);
  if (column.type === 'varchar' && Number(existing.max_length) < column.maxLength) problems.push(`max_length ${existing.max_length} < ${column.maxLength}`);
  if (Boolean(existing.is_unique) !== Boolean(column.dbUnique)) problems.push(`is_unique ${existing.is_unique} != ${column.dbUnique}`);
  if (Boolean(existing.is_mandatory) !== Boolean(column.mandatory)) problems.push(`is_mandatory ${existing.is_mandatory} != ${column.mandatory}`);
  return problems;
};

const main = async () => {
  if (!['Development', 'Production'].includes(environment)) throw new Error('--env must be Development or Production');
  if (environment === 'Production' && apply && !process.argv.includes('--i-understand-production')) {
    throw new Error('Refusing to change Production without --i-understand-production');
  }
  console.log(`${apply ? 'APPLY' : 'DRY RUN'} on ${environment}`);

  const { tables } = buildSpec();
  const existingTables = await request('GET', '/table', { environment });
  const byName = new Map(existingTables.map((t) => [t.table_name, t]));
  const report = [];

  for (const spec of tables) {
    const entry = { table: spec.table, created: false, columnsAdded: 0, drift: [] };
    if (!byName.has(spec.table)) {
      entry.created = true;
      if (apply) {
        await request('POST', '/table', { environment, body: { table_name: spec.table } });
        // A new table is not visible to the column API immediately (eventual consistency).
        for (let i = 0; i < 15; i += 1) {
          try {
            await request('GET', `/table/${spec.table}/column`, { environment, retries: 0 });
            break;
          } catch (error) {
            if (error.code !== 'INVALID_NAME' || i === 14) throw error;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      }
    }
    const existingColumns = entry.created ? [] : await request('GET', `/table/${spec.table}/column`, { environment });
    const columnsByName = new Map(existingColumns.map((c) => [c.column_name, c]));
    const missing = spec.columns.filter((c) => !columnsByName.has(c.name));
    for (const column of spec.columns.filter((c) => columnsByName.has(c.name))) {
      const problems = drift(column, columnsByName.get(column.name));
      if (problems.length) entry.drift.push(`${column.name}: ${problems.join(', ')}`);
    }
    if (missing.length) {
      entry.columnsAdded = missing.length;
      if (apply) await request('POST', `/table/${spec.table}/column`, { environment, body: missing.map(columnBody) });
    }
    report.push(entry);
  }

  console.table(report.map((r) => ({ table: r.table, create: r.created ? 'yes' : '', addColumns: r.columnsAdded || '', drift: r.drift.length || '' })));
  for (const r of report.filter((x) => x.drift.length)) console.log(`DRIFT ${r.table}:\n  ${r.drift.join('\n  ')}`);
  const lock = await request('GET', '/nosqltable', { environment }).catch(() => null);
  const hasLock = Array.isArray(lock) && lock.some((t) => t.name === 'bhoomi_locks' || t.table_name === 'bhoomi_locks');
  console.log(`NoSQL lock table bhoomi_locks: ${hasLock ? 'present' : 'MISSING (create it in the console)'}`);
  if (!apply) console.log('Dry run only. Re-run with --apply to create the missing tables/columns.');
  process.exitCode = report.some((r) => r.drift.length) || !hasLock ? 1 : 0;
};

main().catch((error) => {
  console.error(`provision failed: ${error.code || ''} ${error.message}`);
  process.exitCode = 1;
});
