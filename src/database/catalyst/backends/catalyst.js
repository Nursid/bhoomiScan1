/**
 * Catalyst backend: Data Store via ZCQL + row API, registry via NoSQL conditional insert.
 * Request shapes were verified live on the BhoomiScan Development project (see
 * docs/CATALYST_DATA_STORE_ASSESSMENT.md section 6 / 7).
 *
 * ZCQL behaviour handled here (verified live, Development, 18 Oct 2026):
 *   - at most 300 rows per SELECT: results are paged
 *   - LIMIT's offset is 1-based ("LIMIT 2, 3" starts at the 2nd row)
 *   - the documented 20-column cap was NOT enforced (30 columns returned): one query is
 *     used, with a column-group fallback if Catalyst rejects a wide SELECT
 *   - numbers / booleans come back as strings (convert.js handles that)
 *   - UPDATE returns the full updated rows; DELETE returns DELETED_ROWS_COUNT
 * ROWID is kept as a string: it exceeds JavaScript's safe integer range.
 */

const { request } = require('../client');

const MAX_ROWS = 300;
const MAX_COLUMNS = 20;
const INSERT_BATCH = 100;
const LOCK_TABLE = process.env.CATALYST_LOCK_TABLE || 'bhoomi_locks';

/* --------------------------------- ZCQL --------------------------------- */

const ident = (name) => {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`Unsafe identifier ${name}`);
  return name;
};

/** ZCQL literal for a stored value. Strings are single-quoted with quotes doubled. */
const literal = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite number in query');
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `'${String(value).replace(/'/g, "''")}'`;
};

const likeLiteral = (value, mode) => {
  const escaped = String(value).replace(/'/g, "''").replace(/\*/g, '');
  return mode === 'startsWith' ? `'${escaped}*'` : `'*${escaped}*'`;
};

/** Returns a SQL fragment, or null when the condition can never match (e.g. IN ()). */
const conditionSql = (condition, storedValue) => {
  if (condition.or) {
    const groups = condition.or.map((group) => whereSql(group, storedValue)).filter((sql) => sql !== null);
    if (groups.length === 0) return null;
    return `(${groups.map((sql) => (sql === '' ? '1 = 1' : `(${sql})`)).join(' OR ')})`;
  }
  const { column, op, value } = condition;
  const col = ident(column.name);
  const v = (x) => {
    if (column.name === 'ROWID') {
      if (!/^\d+$/.test(String(x))) throw new Error('Invalid ROWID');
      return String(x); // numeric, exceeds JS safe integers: kept as validated digits
    }
    return literal(storedValue(column, x));
  };
  switch (op) {
    case 'isNull':
      return value ? `${col} IS NULL` : `${col} IS NOT NULL`;
    case 'equals':
      return `${col} = ${v(value)}`;
    case 'not':
      return `${col} != ${v(value)}`;
    case 'in':
      return value.length ? `${col} IN (${value.map(v).join(', ')})` : null;
    case 'notIn':
      return value.length ? `${col} NOT IN (${value.map(v).join(', ')})` : '';
    case 'gt':
      return `${col} > ${v(value)}`;
    case 'gte':
      return `${col} >= ${v(value)}`;
    case 'lt':
      return `${col} < ${v(value)}`;
    case 'lte':
      return `${col} <= ${v(value)}`;
    case 'contains':
    case 'startsWith':
      return `${col} LIKE ${likeLiteral(value, op)}`;
    default:
      throw new Error(`Unsupported operator ${op}`);
  }
};

/** '' = no filter, null = matches nothing. */
const whereSql = (conditions, storedValue) => {
  const parts = [];
  for (const condition of conditions) {
    const sql = conditionSql(condition, storedValue);
    if (sql === null) return null;
    if (sql) parts.push(sql);
  }
  return parts.join(' AND ');
};

const zcql = async (query) => {
  const data = await request('POST', '/query', { body: { query }, retries: /^\s*SELECT/i.test(query) ? 2 : 0 });
  return Array.isArray(data) ? data : [];
};

const columnGroups = (spec) => {
  const names = spec.columns.map((c) => c.name);
  const size = MAX_COLUMNS - 1; // + ROWID
  const groups = [];
  for (let i = 0; i < names.length; i += size) groups.push(names.slice(i, i + size));
  return groups;
};

const tableSpec = (name) => require('../datastore').TABLES[name];

/* ------------------------------- datastore ------------------------------- */

const datastore = {
  async insert(name, records) {
    const out = [];
    for (let i = 0; i < records.length; i += INSERT_BATCH) {
      const data = await request('POST', `/table/${ident(name)}/row`, { body: records.slice(i, i + INSERT_BATCH) });
      out.push(...(Array.isArray(data) ? data : [data]));
    }
    return out;
  },

  async select(name, { conditions, order, limit, offset = 0, storedValue }) {
    const where = whereSql(conditions, storedValue);
    if (where === null) return [];
    const spec = tableSpec(name);
    const orderSql = ` ORDER BY ${[...order.map(({ column, direction }) => `${ident(column.name)} ${direction.toUpperCase()}`), 'ROWID ASC'].join(', ')}`;
    const groups = columnGroups(spec);

    // ZCQL LIMIT offsets are 1-based.
    const pageQuery = (cols, pageOffset, take) =>
      zcql(`SELECT ROWID, ${cols.map(ident).join(', ')} FROM ${ident(name)}${where ? ` WHERE ${where}` : ''}${orderSql} LIMIT ${pageOffset + 1}, ${take}`);

    const page = async (pageOffset, take) => {
      let results;
      try {
        results = [await pageQuery(spec.columns.map((c) => c.name), pageOffset, take)];
      } catch (error) {
        if (!(error.status >= 400 && error.status < 500) || groups.length === 1) throw error;
        // Wide SELECT rejected (documented 20-column cap): read column groups, merge by ROWID.
        results = await Promise.all(groups.map((cols) => pageQuery(cols, pageOffset, take)));
      }
      const merged = new Map();
      results.forEach((rows) =>
        rows.forEach((row) => {
          const record = row[name] || {};
          const key = String(record.ROWID);
          merged.set(key, { ...(merged.get(key) || {}), ...record, ROWID: key });
        }),
      );
      // keep the order of the first group
      return results[0].map((row) => merged.get(String(row[name].ROWID)));
    };

    const out = [];
    let pageOffset = offset;
    let remaining = limit === undefined ? Infinity : limit;
    while (remaining > 0) {
      const take = Math.min(MAX_ROWS, remaining);
      const rows = await page(pageOffset, take);
      out.push(...rows);
      if (rows.length < take) break;
      pageOffset += take;
      remaining -= take;
    }
    return out;
  },

  async count(name, { conditions, storedValue }) {
    const where = whereSql(conditions, storedValue);
    if (where === null) return 0;
    const rows = await zcql(`SELECT COUNT(ROWID) FROM ${ident(name)}${where ? ` WHERE ${where}` : ''}`);
    const record = rows[0]?.[name] || rows[0] || {};
    const value = Object.values(record).find((v) => /^\d+$/.test(String(v)));
    return value === undefined ? 0 : Number(value);
  },

  async update(name, { conditions, set, storedValue }) {
    const where = whereSql(conditions, storedValue);
    if (where === null) return [];
    if (!where) throw new Error('Refusing UPDATE without WHERE');
    const assignments = Object.entries(set).map(([column, value]) => `${ident(column)} = ${literal(value)}`);
    if (assignments.length === 0) return datastore.select(name, { conditions, order: [], storedValue });
    const statement = (whereClause) => zcql(`UPDATE ${ident(name)} SET ${assignments.join(', ')} WHERE ${whereClause}`);
    // UPDATE returns the full updated rows (verified with a 30-column table) and, like
    // DELETE, touches at most MAX_ROWS rows per statement.
    const updated = (await statement(where)).map((row) => row[name] || row);
    if (updated.length < MAX_ROWS) return updated;
    // Possibly more rows: update the rest by id (repeating the same statement could
    // re-update the same rows when the patch does not change the filter).
    const done = new Set(updated.map((row) => row.id));
    const matching = await datastore.select(name, { conditions, order: [], storedValue });
    const rest = [...new Set(matching.map((row) => row.id).filter((id) => !done.has(id)))];
    for (let i = 0; i < rest.length; i += 200) {
      const ids = rest.slice(i, i + 200).map(literal).join(', ');
      const more = await statement(`${where} AND id IN (${ids})`);
      updated.push(...more.map((row) => row[name] || row));
    }
    return updated;
  },

  async remove(name, { conditions, storedValue }) {
    const where = whereSql(conditions, storedValue);
    if (where === null) return 0;
    if (!where) throw new Error('Refusing DELETE without WHERE');
    // DELETE removes at most MAX_ROWS rows per statement (verified: 300 of 310): repeat
    // until nothing matches. Safe to loop, deleted rows no longer match.
    let total = 0;
    for (;;) {
      const rows = await zcql(`DELETE FROM ${ident(name)} WHERE ${where}`);
      const counted = rows[0]?.[name]?.DELETED_ROWS_COUNT ?? rows[0]?.DELETED_ROWS_COUNT;
      const removed = counted === undefined ? rows.length : Number(counted);
      total += removed;
      if (removed < MAX_ROWS) return total;
    }
  },
};

/* ------------------------------- registry -------------------------------- */

const itemFor = (key, value, { expiresAt, data } = {}) => ({
  lock_key: { S: key },
  owner: { S: value },
  ...(expiresAt ? { expires_at: { N: String(Math.floor(new Date(expiresAt).getTime() / 1000)) } } : {}),
  ...(data ? { data: { S: JSON.stringify(data) } } : {}),
});

const parseItem = (item) => {
  if (!item || !item.lock_key) return null;
  const expires = item.expires_at?.N;
  let data = null;
  try {
    data = item.data?.S ? JSON.parse(item.data.S) : null;
  } catch {
    data = null;
  }
  return { value: item.owner?.S ?? null, expiresAt: expires ? new Date(Number(expires) * 1000) : null, data };
};

/** Finds the first object that looks like a stored item anywhere in a NoSQL response. */
const findItem = (node) => {
  if (!node || typeof node !== 'object') return null;
  if (node.lock_key && (node.lock_key.S !== undefined || typeof node.lock_key === 'string')) return node;
  for (const child of Object.values(node)) {
    const found = findItem(child);
    if (found) return found;
  }
  return null;
};

const registry = {
  async get(key) {
    const data = await request('POST', `/nosqltable/${LOCK_TABLE}/item/fetch`, { body: { keys: [{ lock_key: { S: key } }] }, retries: 2 });
    return parseItem(findItem(data));
  },

  async claim(key, value, options = {}) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let status = null;
      try {
        const data = await request('POST', `/nosqltable/${LOCK_TABLE}/item`, {
          body: [
            {
              item: itemFor(key, value, options),
              condition: { function: { function_name: 'attribute_exists', args: [{ attribute_path: ['lock_key'] }] }, negate: true },
              return: 'NULL',
            },
          ],
        });
        status = data?.create?.[0]?.status || null;
      } catch (error) {
        status = null; // 500 / timeout under contention: outcome unknown, read back below
        if (error.code === 'CATALYST_AUTH_FAILED' || error.code === 'CATALYST_NOT_CONFIGURED') throw error;
      }
      if (status === 'Success') return { won: true, current: { value, expiresAt: options.expiresAt || null, data: options.data || null } };
      const current = await registry.get(key);
      if (current) return { won: current.value === value, current };
      if (status === 'CriteriaMismatch') continue; // owner vanished between insert and read: retry
    }
    // Outcome still unknown: an in-flight insert could land later. Remove it if it is ours,
    // so a failed claim does not leave a permanent key nobody knows it owns.
    await registry.release(key, value);
    throw new Error(`Could not resolve claim ${key}`);
  },

  async release(key, value) {
    try {
      const data = await request('DELETE', `/nosqltable/${LOCK_TABLE}/item`, {
        body: [{ keys: { lock_key: { S: key } }, condition: { attribute: 'owner', operator: 'equals', value: { S: value } }, return: 'NULL' }],
      });
      return data?.delete?.[0]?.status === 'Success';
    } catch {
      return false;
    }
  },
};

module.exports = { datastore, registry, __testing: { literal, whereSql, columnGroups, likeLiteral } };
