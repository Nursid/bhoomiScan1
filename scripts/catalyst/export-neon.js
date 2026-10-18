/**
 * Read-only export of every table from the current PostgreSQL (Neon) database into
 * CSV files shaped for Catalyst Data Store (`catalyst ds:import`), plus a manifest
 * with source counts, exported counts, checksums and every conversion error.
 *
 *   node scripts/catalyst/export-neon.js [--out catalyst-export]
 *
 * Never writes to the source database. Exit code 1 when any row failed to convert:
 * nothing is skipped silently, and an export with errors must not be imported.
 * The output contains production data: it is git-ignored and must not be committed.
 */

const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { prisma } = require('../../src/database/prisma');
const { buildSpec } = require('../../src/database/catalyst/schema');
const { toCatalyst } = require('../../src/database/catalyst/convert');

const BATCH = 500;

const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return `"${String(value).replace(/"/g, '""')}"`;
};

const delegateFor = (modelName) => prisma[modelName[0].toLowerCase() + modelName.slice(1)];

const exportTable = async (tableSpec, limits, outDir) => {
  const delegate = delegateFor(tableSpec.prismaModel);
  const header = tableSpec.columns.map((column) => column.name);
  const file = path.join(outDir, `${tableSpec.table}.csv`);
  const out = fs.createWriteStream(file, { encoding: 'utf8' });
  const hash = createHash('sha256');
  const write = (line) => {
    out.write(`${line}\n`);
    hash.update(`${line}\n`);
  };
  write(header.join(','));

  const sourceCount = await delegate.count();
  const errors = [];
  let exported = 0;
  let cursor = null;
  for (;;) {
    const rows = await delegate.findMany({ orderBy: { id: 'asc' }, take: BATCH, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
    if (rows.length === 0) break;
    for (const row of rows) {
      const { record, errors: rowErrors } = toCatalyst(tableSpec, row, limits);
      if (record) {
        write(header.map((name) => csvCell(record[name])).join(','));
        exported += 1;
      } else {
        rowErrors.forEach((error) => errors.push({ table: tableSpec.table, id: row.id, column: error.column, reason: error.reason }));
      }
    }
    cursor = rows[rows.length - 1].id;
  }
  await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  return { table: tableSpec.table, sourceCount, exported, failed: sourceCount - exported, file: path.basename(file), sha256: hash.digest('hex'), errors };
};

const main = async () => {
  const outArg = process.argv.indexOf('--out');
  const outDir = path.resolve(outArg > -1 ? process.argv[outArg + 1] : 'catalyst-export');
  fs.mkdirSync(outDir, { recursive: true });

  const { tables, limits } = buildSpec();
  const results = [];
  for (const tableSpec of tables) {
    try {
      results.push(await exportTable(tableSpec, limits, outDir));
    } catch (error) {
      // e.g. a table that exists in the schema but not yet in this database
      results.push({ table: tableSpec.table, sourceCount: null, exported: 0, failed: null, error: error.message.split('\n').pop() });
    }
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: (() => {
      try {
        return new URL(process.env.DATABASE_URL).hostname; // host only, never credentials
      } catch {
        return 'unknown';
      }
    })(),
    tables: results.map(({ errors, ...rest }) => ({ ...rest, errorCount: errors ? errors.length : null })),
    errors: results.flatMap((result) => result.errors || []),
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.table(manifest.tables.map(({ table, sourceCount, exported, failed, error }) => ({ table, source: sourceCount, exported, failed, note: error || '' })));
  if (manifest.errors.length) console.table(manifest.errors.slice(0, 20));
  const blocked = manifest.errors.length > 0 || results.some((result) => result.error);
  console.log(blocked ? `NOT READY: ${manifest.errors.length} row error(s), see ${outDir}/manifest.json` : `OK: all rows converted -> ${outDir}`);
  process.exitCode = blocked ? 1 : 0;
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
