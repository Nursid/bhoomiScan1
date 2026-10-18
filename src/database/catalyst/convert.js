/**
 * Row conversion between Prisma (PostgreSQL) values and Catalyst Data Store values,
 * following src/database/catalyst/schema.js. Conversion never truncates or drops
 * data: anything that does not fit is reported as an error for that row.
 */

const { createHash } = require('crypto');

const INT32_MAX = 2147483647;
const INT32_MIN = -2147483648;

class ConversionError extends Error {
  constructor(column, reason) {
    super(`${column}: ${reason}`);
    this.name = 'ConversionError';
    this.column = column;
    this.reason = reason;
  }
}

const isNil = (value) => value === null || value === undefined;

const encode = (column, value) => {
  if (isNil(value)) return null;
  switch (column.encoding) {
    case 'epoch_ms': {
      const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
      if (!Number.isFinite(ms)) throw new ConversionError(column.name, 'invalid date');
      return ms;
    }
    case 'json':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isInteger(value)) throw new ConversionError(column.name, `not an integer (${value})`);
      if (column.type === 'int' && (value > INT32_MAX || value < INT32_MIN)) throw new ConversionError(column.name, 'out of Int range');
      return value;
    case 'boolean':
      return Boolean(value);
    default:
      return String(value);
  }
};

const checkLength = (column, encoded, limits) => {
  if (typeof encoded !== 'string') return;
  const max = column.type === 'varchar' ? column.maxLength || limits.VARCHAR_MAX : column.type === 'text' ? limits.TEXT_MAX : null;
  if (max !== null && encoded.length > max) {
    throw new ConversionError(column.name, `${encoded.length} characters exceeds the ${column.type} limit of ${max}`);
  }
};

/**
 * @param {object} tableSpec  one entry of buildSpec().tables
 * @param {object} row        Prisma row (camelCase fields)
 * @param {object} limits     buildSpec().limits
 * @returns {{ record: object|null, errors: ConversionError[] }}
 */
const toCatalyst = (tableSpec, row, limits) => {
  const record = {};
  const errors = [];
  const byName = Object.fromEntries(tableSpec.columns.map((column) => [column.name, column]));

  for (const column of tableSpec.columns) {
    try {
      let value;
      if (column.encoding === 'derived') {
        const parts = column.derivedFrom.map((name) => row[byName[name].prismaField]);
        if (parts.some(isNil)) throw new ConversionError(column.name, `source field missing (${column.derivedFrom.join(', ')})`);
        value = parts.map(String).join('|');
      } else if (column.encoding === 'sha256') {
        const source = row[byName[column.derivedFrom[0]].prismaField];
        if (isNil(source)) throw new ConversionError(column.name, 'source value missing');
        value = createHash('sha256').update(String(source)).digest('hex');
      } else {
        value = encode(column, row[column.prismaField]);
      }
      if (column.mandatory && isNil(value)) throw new ConversionError(column.name, 'required value is empty');
      checkLength(column, value, limits);
      record[column.name] = value;
    } catch (error) {
      errors.push(error instanceof ConversionError ? error : new ConversionError(column.name, error.message));
    }
  }
  return { record: errors.length ? null : record, errors };
};

/** Catalyst record -> Prisma-shaped object (camelCase, Date, parsed JSON). */
const fromCatalyst = (tableSpec, record) => {
  const row = {};
  for (const column of tableSpec.columns) {
    if (!column.prismaField) continue; // derived helper columns
    const value = record[column.name];
    if (isNil(value) || value === '') {
      row[column.prismaField] = null;
      continue;
    }
    switch (column.encoding) {
      case 'epoch_ms':
        row[column.prismaField] = new Date(Number(value));
        break;
      case 'json':
        row[column.prismaField] = typeof value === 'string' ? JSON.parse(value) : value;
        break;
      case 'number':
        row[column.prismaField] = Number(value);
        break;
      case 'boolean':
        row[column.prismaField] = value === true || value === 'true';
        break;
      default:
        row[column.prismaField] = String(value);
    }
  }
  return row;
};

module.exports = { toCatalyst, fromCatalyst, ConversionError };
