/**
 * PostgreSQL (Prisma) -> Catalyst Data Store mapping.
 *
 * Single source of truth for: creating the Catalyst tables (docs/CATALYST_TABLES.md is
 * generated from this), converting rows during the Neon -> Catalyst migration, and the
 * Catalyst data layer. Derived from the Prisma model so no table or column is missed.
 *
 * Catalyst limits this works around (docs.catalyst.zoho.com, Data Store > Columns / ZCQL):
 *   - primary key is an auto ROWID       -> our UUID `id` is kept as a unique Var Char
 *   - Var Char <= 255, Text <= 10,000    -> long / JSON values go to Text, length-checked
 *   - no JSON type                       -> JSON stored as text (JSON.stringify)
 *   - DateTime has no ms / time zone     -> timestamps stored as BigInt epoch milliseconds
 *   - single-column IsUnique only, and only a few unique Var Char columns per table
 *     ("Reached max number of columns of Unique varchar type", verified live)
 *                                        -> `unique` marks the business rule, enforced by the
 *                                           claim registry; only `id` is also `dbUnique`
 *                                           (Catalyst IsUnique), which rejects a retried insert
 *   - compound uniques                   -> one "<...>_uq" helper column (lookup + registry key)
 *   - Foreign Key type points at ROWID   -> relations kept as UUID strings (app-checked)
 */

const VARCHAR_MAX = 255;
const TEXT_MAX = 10000;

// Free text or values that can exceed 255 characters.
const TEXT_COLUMNS = new Set([
  'subscription_plans.description',
  'payments.failure_reason',
  'land_verifications.display_name',
  'land_verifications.last_error_message',
  'land_record_changes.field',
  'smart_contract_records.error_message',
  'alerts.message',
  'api_request_logs.endpoint',
  'api_request_logs.error_message',
  'device_tokens.token',
  'notifications.body',
  'notifications.last_error',
]);

// Catalyst reserved words cannot be column names (verified live for all 131 names:
// "interval", "result" and "trigger" are reserved).
// Only the stored column name changes; the application field name stays the same.
const COLUMN_RENAMES = {
  'subscription_plans.interval': 'plan_interval',
  'payment_webhook_events.result': 'process_result',
  'land_record_snapshots.trigger': 'verification_trigger',
};

// Int columns that can exceed a 4-byte integer.
const BIGINT_COLUMNS = new Set(['smart_contract_records.block_number', 'uploaded_documents.block_number']);

// Compound unique constraints -> one unique Var Char column holding the joined values.
const COMPOUND_UNIQUES = {
  payment_webhook_events: [{ column: 'event_uq', fields: ['provider', 'event_id'] }],
  land_verifications: [{ column: 'parcel_uq', fields: ['user_id', 'state_code', 'parcel_key'] }],
  land_record_snapshots: [{ column: 'sequence_uq', fields: ['land_verification_id', 'sequence'] }],
  uploaded_documents: [
    { column: 'hash_uq', fields: ['user_id', 'data_hash'] },
    { column: 'version_uq', fields: ['user_id', 'document_series_id', 'version_number'] },
  ],
};

// Unique values that can be longer than a Var Char: uniqueness is enforced on a sha256.
const HASHED_UNIQUES = { device_tokens: [{ column: 'token_sha256', source: 'token' }] };

const snake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

const columnFor = (table, field) => {
  const sourceName = field.dbName || snake(field.name);
  const key = `${table}.${sourceName}`;
  const name = COLUMN_RENAMES[key] || sourceName;
  const base = { name, prismaField: field.name, mandatory: field.isRequired, unique: Boolean(field.isUnique || field.isId) };

  if (field.kind === 'enum') {
    return field.isList
      ? { ...base, type: 'text', encoding: 'json', note: `${field.type}[] as JSON array` }
      : { ...base, type: 'varchar', maxLength: 40, encoding: 'enum', note: field.type };
  }
  switch (field.type) {
    case 'String':
      if (TEXT_COLUMNS.has(key)) return { ...base, type: 'text', encoding: 'string' };
      return { ...base, type: 'varchar', maxLength: VARCHAR_MAX, encoding: 'string' };
    case 'Int':
      return { ...base, type: BIGINT_COLUMNS.has(key) ? 'bigint' : 'int', encoding: 'number' };
    case 'Boolean':
      return { ...base, type: 'boolean', encoding: 'boolean' };
    case 'DateTime':
      return { ...base, type: 'bigint', encoding: 'epoch_ms', note: 'UTC epoch milliseconds' };
    case 'Json':
      return { ...base, type: 'text', encoding: 'json', note: `JSON text, max ${TEXT_MAX} chars` };
    default:
      throw new Error(`Unmapped Prisma type ${field.type} on ${key}`);
  }
};

/** Builds the full Catalyst schema spec from the Prisma model. */
const buildSpec = (dmmf = require('@prisma/client').Prisma.dmmf) => {
  const tables = dmmf.datamodel.models.map((model) => {
    const table = model.dbName || snake(model.name);
    const columns = model.fields.filter((field) => field.kind !== 'object').map((field) => columnFor(table, field));
    for (const uq of COMPOUND_UNIQUES[table] || []) {
      columns.push({ name: uq.column, type: 'varchar', maxLength: VARCHAR_MAX, mandatory: true, unique: true, encoding: 'derived', derivedFrom: uq.fields, note: `unique(${uq.fields.join(', ')})` });
    }
    for (const hashed of HASHED_UNIQUES[table] || []) {
      const source = columns.find((column) => column.name === hashed.source);
      source.unique = false;
      columns.push({ name: hashed.column, type: 'varchar', maxLength: 64, mandatory: true, unique: true, encoding: 'sha256', derivedFrom: [hashed.source], note: `unique(${hashed.source})` });
    }
    return { table, prismaModel: model.name, columns };
  });
  // Catalyst IsUnique is not race-safe and limited per table: only the row id uses it.
  for (const t of tables) for (const column of t.columns) column.dbUnique = column.name === 'id';
  return { tables, limits: { VARCHAR_MAX, TEXT_MAX } };
};

module.exports = { buildSpec, VARCHAR_MAX, TEXT_MAX, COMPOUND_UNIQUES, HASHED_UNIQUES, COLUMN_RENAMES };
