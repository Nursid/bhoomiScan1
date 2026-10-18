// PostgreSQL -> Catalyst Data Store mapping and row conversion.
const { Prisma } = require('@prisma/client');
const { buildSpec, TEXT_MAX } = require('../../src/database/catalyst/schema');
const { toCatalyst, fromCatalyst } = require('../../src/database/catalyst/convert');

const { tables, limits } = buildSpec();
const table = (name) => tables.find((t) => t.table === name);
const column = (t, name) => table(t).columns.find((c) => c.name === name);

describe('Catalyst schema spec', () => {
  test('covers every Prisma model and every scalar field', () => {
    expect(tables.map((t) => t.prismaModel).sort()).toEqual(Prisma.dmmf.datamodel.models.map((m) => m.name).sort());
    for (const model of Prisma.dmmf.datamodel.models) {
      const mapped = table(model.dbName).columns.map((c) => c.prismaField).filter(Boolean);
      expect(mapped.sort()).toEqual(model.fields.filter((f) => f.kind !== 'object').map((f) => f.name).sort());
    }
  });

  test('only Catalyst types, legal Var Char lengths, ids unique', () => {
    for (const t of tables) {
      expect(column(t.table, 'id')).toMatchObject({ type: 'varchar', unique: true, mandatory: true });
      for (const c of t.columns) {
        expect(['varchar', 'text', 'int', 'bigint', 'boolean']).toContain(c.type);
        if (c.type === 'varchar') expect(c.maxLength).toBeLessThanOrEqual(255);
        expect(c.name).toMatch(/^[a-z][a-z0-9_]*$/);
      }
    }
  });

  test('timestamps are epoch-ms BigInt, JSON is text, compound uniques become one column', () => {
    expect(column('subscriptions', 'ends_at')).toMatchObject({ type: 'bigint', encoding: 'epoch_ms' });
    expect(column('land_record_snapshots', 'raw_response')).toMatchObject({ type: 'text', encoding: 'json' });
    expect(column('subscription_plans', 'allowed_frequencies')).toMatchObject({ type: 'text', encoding: 'json' });
    expect(column('land_verifications', 'parcel_uq')).toMatchObject({ unique: true, derivedFrom: ['user_id', 'state_code', 'parcel_key'] });
    expect(column('payment_webhook_events', 'event_uq').derivedFrom).toEqual(['provider', 'event_id']);
    expect(column('device_tokens', 'token')).toMatchObject({ type: 'text', unique: false });
    expect(column('device_tokens', 'token_sha256')).toMatchObject({ unique: true, encoding: 'sha256' });
  });
});

describe('row conversion', () => {
  const sub = table('subscriptions');
  const row = {
    id: '0b6a7a52-6a53-4d38-9f3e-2f0b4a1f0c11',
    userId: 'ee5bd1ff-721b-45ae-a070-d2be6c9de218',
    planId: '6019ee37-af7c-44fc-be6b-53294a381301',
    status: 'ACTIVE',
    amount: 99900,
    currency: 'INR',
    startsAt: new Date('2026-10-16T06:03:51.123Z'),
    endsAt: new Date('2027-10-16T06:03:51.123Z'),
    activatedAt: new Date('2026-10-16T06:03:51.123Z'),
    cancelledAt: null,
    expiredAt: null,
    createdAt: new Date('2026-10-16T06:03:20.000Z'),
    updatedAt: new Date('2026-10-16T06:03:51.500Z'),
  };

  test('round-trips exactly, including milliseconds and nulls', () => {
    const { record, errors } = toCatalyst(sub, row, limits);
    expect(errors).toEqual([]);
    expect(record).toMatchObject({ starts_at: row.startsAt.getTime(), amount: 99900, cancelled_at: null, status: 'ACTIVE' });
    expect(record.starts_at % 1000).toBe(123); // milliseconds kept
    expect(fromCatalyst(sub, record)).toEqual(row);
  });

  test('JSON and derived unique keys', () => {
    const lv = table('land_verifications');
    const { record } = toCatalyst(
      lv,
      { id: 'a', userId: 'u1', stateCode: 'PUNJAB', provider: 'SUREPASS', parcelKey: 'k1', locator: { district: 'amritsar' }, displayName: null, status: 'VERIFIED', latestSnapshotId: null, verificationCount: 1, changeCount: 0, firstVerifiedAt: null, lastVerifiedAt: null, lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null, consecutiveFailures: 0, monitoringEnabled: false, verificationFrequency: null, nextVerificationAt: null, lockedUntil: null, createdAt: new Date(0), updatedAt: new Date(0) },
      limits,
    );
    expect(record.locator).toBe('{"district":"amritsar"}');
    expect(record.parcel_uq).toBe('u1|PUNJAB|k1');
    expect(fromCatalyst(lv, record).locator).toEqual({ district: 'amritsar' });
  });

  test('never truncates: oversized, missing or out-of-range values are row errors', () => {
    const tooLong = toCatalyst(table('land_record_snapshots'), { id: 's', landVerificationId: 'l', sequence: 1, provider: 'SUREPASS', rawResponse: { x: 'y'.repeat(TEXT_MAX) }, normalizedData: {}, normalizerVersion: '1', hash: 'h', status: 'INITIAL', trigger: 'MANUAL', changeCount: 0, verifiedAt: new Date(), createdAt: new Date() }, limits);
    expect(tooLong.record).toBeNull();
    expect(tooLong.errors.map((e) => e.column)).toEqual(['raw_response']);

    const missing = toCatalyst(sub, { ...row, currency: null }, limits);
    expect(missing.errors[0]).toMatchObject({ column: 'currency', reason: 'required value is empty' });

    const range = toCatalyst(sub, { ...row, amount: 2 ** 31 }, limits);
    expect(range.errors[0]).toMatchObject({ column: 'amount', reason: 'out of Int range' });
  });
});
