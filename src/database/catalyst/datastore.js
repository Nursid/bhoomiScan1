/**
 * Catalyst Data Store repositories, one per table, built from schema.js.
 *
 *   const { table } = require('../database/catalyst/datastore');
 *   const users = table('users');
 *   await users.insert({ id, mobile, ... });                 // Prisma-shaped object in, out
 *   await users.findOne({ mobile: '+91...' });
 *   await users.findMany({ where: { userId, status: { in: ['ACTIVE'] } }, orderBy: [['createdAt', 'desc']], limit: 20, offset: 0 });
 *   await users.updateWhere({ id }, { lastLoginAt: new Date() });  // returns updated rows
 *
 * What this is NOT: there are no joins, no transactions and no database-enforced
 * uniqueness here (Catalyst has none that holds under concurrency, see
 * docs/CATALYST_DATA_STORE_ASSESSMENT.md section 6). Uniqueness, idempotency and
 * locking go through registry.js (NoSQL conditional insert, tested atomic).
 *
 * Physical duplicates of one logical row (same `id`) can exist after a crash or race
 * in a multi-step write; reads collapse rows with the same `id`, and updates / deletes
 * by `id` apply to all copies, so they stay identical.
 *
 * Backend: Catalyst REST (default) or in-memory (tests), see backends/.
 */

const { buildSpec } = require('./schema');
const { toCatalyst, fromCatalyst } = require('./convert');

const SPEC = buildSpec();
const TABLES = Object.fromEntries(SPEC.tables.map((t) => [t.table, t]));

let backend = null;
const getBackend = () => {
  if (!backend) {
    backend = process.env.DATA_BACKEND === 'memory' ? require('./backends/memory').datastore : require('./backends/catalyst').datastore;
  }
  return backend;
};
const setBackend = (next) => {
  backend = next;
};

class DataStoreError extends Error {
  constructor(message, code = 'DATASTORE_ERROR', details) {
    super(message);
    this.name = 'DataStoreError';
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------- where -> AST ------------------------------ */

const OPERATORS = new Set(['equals', 'not', 'in', 'notIn', 'gt', 'gte', 'lt', 'lte', 'contains', 'startsWith', 'isNull']);

/**
 * Normalises a where object (Prisma field names) into a list of conditions on Catalyst
 * column names: [{ column, op, value, encoding }], plus OR groups: { or: [conditions[]] }.
 */
const compileWhere = (spec, where = {}) => {
  const byField = Object.fromEntries(spec.columns.filter((c) => c.prismaField).map((c) => [c.prismaField, c]));
  const conditions = [];
  for (const [field, raw] of Object.entries(where)) {
    if (raw === undefined) continue;
    if (field === 'OR') {
      conditions.push({ or: raw.map((group) => compileWhere(spec, group)) });
      continue;
    }
    const column = byField[field] || spec.columns.find((c) => c.name === field);
    if (!column) throw new DataStoreError(`Unknown field ${spec.table}.${field}`, 'UNKNOWN_FIELD');
    const isOperatorObject = raw !== null && typeof raw === 'object' && !(raw instanceof Date) && !Array.isArray(raw);
    const entries = isOperatorObject ? Object.entries(raw) : [['equals', raw]];
    for (const [op, value] of entries) {
      if (!OPERATORS.has(op)) throw new DataStoreError(`Unsupported operator ${op} on ${spec.table}.${field}`, 'UNSUPPORTED_OPERATOR');
      if (op === 'equals' && value === null) conditions.push({ column, op: 'isNull', value: true });
      else if (op === 'not' && value === null) conditions.push({ column, op: 'isNull', value: false });
      else conditions.push({ column, op, value });
    }
  }
  return conditions;
};

/** JS value -> stored representation (for comparisons), using the column encoding. */
const storedValue = (column, value) => {
  if (value === null || value === undefined) return null;
  if (column.encoding === 'epoch_ms') return value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (column.encoding === 'boolean') return Boolean(value);
  if (column.encoding === 'number') return Number(value);
  return String(value);
};

const compileOrder = (spec, orderBy = []) =>
  orderBy.map(([field, direction = 'asc']) => {
    const column = spec.columns.find((c) => c.prismaField === field || c.name === field);
    if (!column) throw new DataStoreError(`Unknown sort field ${spec.table}.${field}`, 'UNKNOWN_FIELD');
    return { column, direction: direction.toLowerCase() === 'desc' ? 'desc' : 'asc' };
  });

/* --------------------------------- helpers -------------------------------- */

/** Collapse physical duplicates (same `id`), keeping the first occurrence. */
const dedupe = (records) => {
  const seen = new Set();
  return records.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
};

const encodePatch = (spec, patch) => {
  const out = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const column = spec.columns.find((c) => c.prismaField === field);
    if (!column) throw new DataStoreError(`Unknown field ${spec.table}.${field}`, 'UNKNOWN_FIELD');
    if (column.mandatory && (value === null || value === '')) throw new DataStoreError(`${spec.table}.${field} is required`, 'REQUIRED_FIELD');
    if (value === null) {
      out[column.name] = null;
      continue;
    }
    const { record, errors } = toCatalyst({ ...spec, columns: [{ ...column, mandatory: false }] }, { [field]: value }, SPEC.limits);
    if (errors.length) throw new DataStoreError(errors[0].message, 'INVALID_VALUE', { field });
    out[column.name] = record[column.name];
  }
  // Derived unique helper columns must follow their sources.
  for (const column of spec.columns.filter((c) => c.encoding === 'derived' || c.encoding === 'sha256')) {
    if (column.derivedFrom.some((name) => name in out)) {
      throw new DataStoreError(`${spec.table}: changing ${column.derivedFrom.join(', ')} is not supported (unique key ${column.name})`, 'IMMUTABLE_KEY');
    }
  }
  return out;
};

/* ------------------------------- repository ------------------------------- */

const table = (name) => {
  const spec = TABLES[name];
  if (!spec) throw new DataStoreError(`Unknown table ${name}`, 'UNKNOWN_TABLE');

  const decode = (record) => fromCatalyst(spec, record);

  const encodeRow = (row) => {
    const { record, errors } = toCatalyst(spec, row, SPEC.limits);
    if (errors.length) {
      throw new DataStoreError(`${name}: ${errors.map((e) => e.message).join('; ')}`, 'INVALID_ROW', errors.map((e) => ({ column: e.column, reason: e.reason })));
    }
    return record;
  };

  const repo = {
    name,
    spec,

    /**
     * Inserts one row or an array (one batch is all-or-nothing within this table).
     * With { idempotent: true } (single row with an `id`), a row that already exists with
     * that id is returned instead of failing: a retried step of a multi-step workflow
     * re-creates nothing. (Catalyst rejects a *later* duplicate id; a simultaneous one can
     * slip through, and reads then collapse the copies.)
     */
    async insert(rows, { idempotent = false } = {}) {
      const list = Array.isArray(rows) ? rows : [rows];
      if (list.length === 0) return [];
      const now = new Date();
      const prepared = list.map((row) => encodeRow({ createdAt: now, ...(spec.columns.some((c) => c.prismaField === 'updatedAt') ? { updatedAt: now } : {}), ...row }));
      let stored;
      try {
        stored = await getBackend().insert(name, prepared);
      } catch (error) {
        if (idempotent && error.code === 'DUPLICATE_VALUE' && !Array.isArray(rows) && rows.id) {
          const existing = await repo.findById(rows.id);
          if (existing) return existing;
        }
        throw error;
      }
      const out = stored.map(decode);
      return Array.isArray(rows) ? out : out[0];
    },

    async findMany({ where = {}, orderBy = [], limit, offset = 0, select } = {}) {
      const conditions = compileWhere(spec, where);
      const order = compileOrder(spec, orderBy.length ? orderBy : [['id', 'asc']]);
      const records = await getBackend().select(name, { conditions, order, limit, offset, storedValue, select });
      return dedupe(records).map(decode);
    },

    async findOne(where, options = {}) {
      const [row] = await repo.findMany({ ...options, where, limit: 1 });
      return row || null;
    },

    async findById(id) {
      return id ? repo.findOne({ id }) : null;
    },

    async findByIdOrThrow(id, code = 'NOT_FOUND') {
      const row = await repo.findById(id);
      if (!row) throw new DataStoreError(`${name} ${id} not found`, code);
      return row;
    },

    async count(where = {}) {
      return getBackend().count(name, { conditions: compileWhere(spec, where), storedValue });
    },

    /**
     * Updates every row matching `where`; returns the updated rows (deduplicated).
     * NOT atomic: two concurrent calls with the same `where` can both "succeed" (verified
     * live). Never use the returned rows to decide who won; use registry.claim() for that.
     */
    async updateWhere(where, patch) {
      const conditions = compileWhere(spec, where);
      if (conditions.length === 0) throw new DataStoreError('updateWhere without a condition is not allowed', 'UNSAFE_UPDATE');
      const set = encodePatch(spec, spec.columns.some((c) => c.prismaField === 'updatedAt') ? { updatedAt: new Date(), ...patch } : patch);
      const updated = await getBackend().update(name, { conditions, set, storedValue });
      return dedupe(updated).map(decode);
    },

    async updateById(id, patch) {
      const [row] = await repo.updateWhere({ id }, patch);
      return row || null;
    },

    async deleteWhere(where) {
      const conditions = compileWhere(spec, where);
      if (conditions.length === 0) throw new DataStoreError('deleteWhere without a condition is not allowed', 'UNSAFE_DELETE');
      return getBackend().remove(name, { conditions, storedValue });
    },
  };
  return repo;
};

module.exports = { table, TABLES, DataStoreError, setBackend, __testing: { compileWhere, compileOrder, dedupe, storedValue } };
