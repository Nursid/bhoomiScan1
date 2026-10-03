const { prisma, resetDb, installFetch, api, login, giveActiveSubscription, settle } = require('./helpers');
const smartContractService = require('../../src/modules/smart-contract/smart-contract.service');
const recurringJob = require('../../src/jobs/recurring-verification.job');

const SP = 'https://sandbox\\.surepass\\.test/api/v1/land-verification/punjab';
const SC = /^https:\/\/contracts\.test\/records$/;

const LOCATOR = { district: 'amritsar', tehsil: 'ajnala', village: 'abu said', year: '2020 - 2021', khasra_number: '14//6/2---1' };

// What Surepass returns for the parcel; tests mutate it between calls.
let landData;
const baseRecord = () => ({
  client_id: `land_${Math.random().toString(36).slice(2)}`,
  district: 'Amritsar',
  tehsil: 'Ajnala',
  village: 'Abu Said',
  year: '2020 - 2021',
  khasra_number: '14//6/2---1',
  khewat_no: '45',
  owner_details: [
    { owner_name: 'Gurpreet Singh', father_name: 'Harbans Singh', share: '1/2' },
    { owner_name: 'Manjit Kaur', father_name: 'Harbans Singh', share: '1/2' },
  ],
  area: '0-12-5',
  fetched_at: new Date().toISOString(),
});

let fake;
let scMode = 'ok';
let scCounter = 0;

beforeAll(async () => {
  await resetDb();
  fake = installFetch();
  fake.on('GET', new RegExp(`${SP}/meta/district-list$`), { body: { success: true, status_code: 200, data: ['Amritsar', 'Ludhiana'] } });
  fake.on('POST', new RegExp(`${SP}/meta/tehsil-list$`), (url, init, body) => ({ body: { success: true, data: body.district === 'amritsar' ? ['Ajnala'] : [] } }));
  fake.on('POST', new RegExp(`${SP}$`), (url, init, body) =>
    body.khasra_number === '99/9'
      ? { status: 422, body: { success: false, status_code: 422, message: 'No record found' } }
      : { body: { success: true, status_code: 200, message_code: 'success', data: { ...landData, client_id: `land_${Math.random()}` } } },
  );
  fake.on('POST', SC, () => {
    if (scMode === 'down') return { status: 503, body: { message: 'maintenance' } };
    scCounter += 1;
    return { status: 201, body: { id: `sc_${scCounter}`, transactionHash: `0x${String(scCounter).padStart(64, '0')}`, network: 'test-chain' } };
  });
});

afterAll(async () => {
  fake.restore();
  await settle();
  await prisma.$disconnect();
});

describe('land verification', () => {
  let app;
  let owner;
  let verificationId;
  const snapshotIds = [];

  beforeAll(async () => {
    app = api();
    owner = await login(app, '9811111111');
    await giveActiveSubscription(owner.user.id, 'quarterly');
  });

  test('metadata lists are proxied, validated and cached', async () => {
    const first = await app.get('/api/v1/land-verification/punjab/districts').set(owner.auth);
    expect(first.status).toBe(200);
    expect(first.body.data.options).toEqual([
      { value: 'Amritsar', label: 'Amritsar' },
      { value: 'Ludhiana', label: 'Ludhiana' },
    ]);
    expect(first.body.data.cached).toBe(false);
    const second = await app.get('/api/v1/land-verification/punjab/districts').set(owner.auth);
    expect(second.body.data.cached).toBe(true);
    expect(fake.callsTo(/district-list/)).toHaveLength(1);

    const tehsils = await app.post('/api/v1/land-verification/punjab/tehsils').set(owner.auth).send({ district: 'amritsar' });
    expect(tehsils.body.data.options).toEqual([{ value: 'Ajnala', label: 'Ajnala' }]);
    expect(fake.callsTo(/tehsil-list/)[0].headers.authorization).toBe('Bearer surepass-test-token');

    const invalid = await app.post('/api/v1/land-verification/punjab/villages').set(owner.auth).send({ district: 'amritsar' });
    expect(invalid.status).toBe(422);
    expect(invalid.body.error.details[0].field).toBe('tehsil');

    const unknownState = await app.get('/api/v1/land-verification/kerala/districts').set(owner.auth);
    expect(unknownState.status).toBe(404);
    expect(unknownState.body.error.code).toBe('STATE_NOT_SUPPORTED');
  });

  test('first verification stores snapshot + smart contract record (VERIFIED)', async () => {
    landData = baseRecord();
    const res = await app.post('/api/v1/land-verification/punjab/verify').set(owner.auth).send(LOCATOR);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ status: 'VERIFIED', snapshotStatus: 'INITIAL', isFirstVerification: true, previousVerification: null, changes: [] });
    expect(data.smartContract).toMatchObject({ status: 'STORED', reference: 'sc_1' });
    expect(data.record.client_id).toBeUndefined(); // ignored noise
    expect(data.record.owner_details).toHaveLength(2);
    verificationId = data.verificationId;
    snapshotIds.push(data.currentVerification);

    const snapshot = await prisma.landRecordSnapshot.findUnique({ where: { id: data.currentVerification } });
    expect(snapshot.rawResponse.data.client_id).toMatch(/^land_/); // full raw response kept
    expect(snapshot.providerReference).toMatch(/^land_/);
    const scCall = fake.callsTo(SC)[0];
    expect(scCall.body).toMatchObject({ referenceId: data.currentVerification, dataHash: data.hash, propertyId: 'PB:amritsar:ajnala:abu said:2020-2021:14//6/2---1' });
    expect(scCall.headers['x-api-key']).toBe('sc-test-key');
  });

  test('same land, reordered/renamed noise -> UNCHANGED, no false differences; hash reused on chain', async () => {
    const record = baseRecord();
    landData = {
      fetched_at: 'later',
      area: ' 0-12-5 ',
      owner_details: [...record.owner_details].reverse().map((o) => ({ share: o.share, father_name: o.father_name.toUpperCase(), owner_name: o.owner_name })),
      khewat_no: 45,
      khasra_number: record.khasra_number,
      year: record.year,
      village: 'ABU SAID',
      tehsil: record.tehsil,
      district: record.district,
      timestamp: Date.now(),
    };
    const scCallsBefore = fake.callsTo(SC).length;
    const res = await app.post('/api/v1/land-verification/punjab/verify').set(owner.auth).send({ ...LOCATOR, year: '2020-2021' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ verificationId, status: 'UNCHANGED', previousVerification: snapshotIds[0], changes: [] });
    expect(res.body.data.smartContract.status).toBe('ALREADY_STORED');
    expect(fake.callsTo(SC).length).toBe(scCallsBefore);
    snapshotIds.push(res.body.data.currentVerification);
  });

  test('owner change -> CHANGED with change list + alert; smart contract outage does not fail verification', async () => {
    landData = baseRecord();
    landData.owner_details[1] = { owner_name: 'Simran Kaur', father_name: 'Harbans Singh', share: '1/2' };
    landData.remarks = 'Mutation 1234 sanctioned';
    scMode = 'down';

    const res = await app.post('/api/v1/land-verification/punjab/verify').set(owner.auth).send(LOCATOR);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.status).toBe('CHANGED');
    expect(data.previousVerification).toBe(snapshotIds[1]);
    expect(data.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'REMOVE', field: 'owner_details[]', isCritical: true }),
        expect.objectContaining({ type: 'ADD', field: 'owner_details[]', currentValue: { owner_name: 'simran kaur', father_name: 'harbans singh', share: '1/2' } }),
        expect.objectContaining({ type: 'ADD', field: 'remarks', currentValue: 'mutation 1234 sanctioned', isCritical: true }),
      ]),
    );
    expect(data.changeSummary.total).toBe(3);
    expect(data.alertId).toBeTruthy();
    expect(data.smartContract.status).toBe('FAILED');
    snapshotIds.push(data.currentVerification);

    const record = await prisma.smartContractRecord.findUnique({ where: { snapshotId: data.currentVerification } });
    expect(record).toMatchObject({ status: 'FAILED', attempts: 1, errorCode: 'SMART_CONTRACT_UNAVAILABLE' });
    expect(record.nextRetryAt.getTime()).toBeGreaterThan(Date.now());

    const alert = await prisma.alert.findUnique({ where: { id: data.alertId } });
    expect(alert).toMatchObject({ type: 'LAND_RECORD_CHANGED', severity: 'CRITICAL', status: 'UNREAD' });
  });

  test('retry job stores the failed smart contract record once the API is back', async () => {
    scMode = 'ok';
    await prisma.smartContractRecord.updateMany({ where: { status: 'FAILED' }, data: { nextRetryAt: new Date(Date.now() - 1000) } });
    const result = await smartContractService.processDueRecords();
    expect(result).toEqual({ processed: 1, stored: 1 });
    const record = await prisma.smartContractRecord.findUnique({ where: { snapshotId: snapshotIds[2] } });
    expect(record).toMatchObject({ status: 'STORED', attempts: 2, errorCode: null });
    expect(record.transactionHash).toMatch(/^0x0+2$/);
  });

  test('read APIs: detail, history, single snapshot, changes, smart contract records', async () => {
    const detail = await app.get(`/api/v1/land-verification/${verificationId}`).set(owner.auth);
    expect(detail.status).toBe(200);
    expect(detail.body.data.verification).toMatchObject({ status: 'CHANGED', verificationCount: 3, changeCount: 3, latestSnapshotId: snapshotIds[2] });
    expect(detail.body.data.latestChanges).toHaveLength(3);

    const history = await app.get(`/api/v1/land-verification/${verificationId}/history`).set(owner.auth);
    expect(history.body.data.snapshots.map((s) => s.status)).toEqual(['CHANGED', 'UNCHANGED', 'INITIAL']);
    expect(history.body.data.snapshots[0].rawResponse).toBeUndefined();
    expect(history.body.meta.total).toBe(3);

    const one = await app.get(`/api/v1/land-verification/${verificationId}/history/${snapshotIds[0]}`).set(owner.auth);
    expect(one.body.data.snapshot.rawResponse.success).toBe(true);

    const changes = await app.get(`/api/v1/land-verification/${verificationId}/changes?critical=true`).set(owner.auth);
    expect(changes.body.data.changes.length).toBeGreaterThanOrEqual(2);
    expect(changes.body.data.changes.every((c) => c.isCritical)).toBe(true);

    const records = await app.get(`/api/v1/smart-contract/records?landVerificationId=${verificationId}`).set(owner.auth);
    expect(records.body.data.records.map((r) => r.status).sort()).toEqual(['ALREADY_STORED', 'STORED', 'STORED']);

    const list = await app.get('/api/v1/land-verification').set(owner.auth);
    expect(list.body.data.verifications).toHaveLength(1);
  });

  test('alerts can be listed and marked read', async () => {
    const list = await app.get('/api/v1/alerts?status=UNREAD').set(owner.auth);
    expect(list.body.data.unread).toBe(1);
    const read = await app.patch(`/api/v1/alerts/${list.body.data.alerts[0].id}/read`).set(owner.auth);
    expect(read.body.data.alert.status).toBe('READ');
  });

  test('other users cannot see this parcel', async () => {
    const stranger = await login(app, '9822222222');
    const res = await app.get(`/api/v1/land-verification/${verificationId}`).set(stranger.auth);
    expect(res.status).toBe(404);
    const changes = await app.get(`/api/v1/land-verification/${verificationId}/changes`).set(stranger.auth);
    expect(changes.status).toBe(404);
  });

  test('provider "not found" -> 404 and no parcel is created', async () => {
    const res = await app.post('/api/v1/land-verification/punjab/verify').set(owner.auth).send({ ...LOCATOR, khasra_number: '99/9' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LAND_RECORD_NOT_FOUND');
    expect(await prisma.landVerification.count()).toBe(1);
  });

  test('invalid verify payload -> 422', async () => {
    const res = await app.post('/api/v1/land-verification/punjab/verify').set(owner.auth).send({ ...LOCATOR, year: '2020', extra: 1 });
    expect(res.status).toBe(422);
    // "year" is malformed and "extra" is an unknown key (strict schema, reported on the body).
    expect(res.body.error.details.map((d) => d.field)).toEqual(expect.arrayContaining(['year', 'body']));
  });

  test('recurring verification: plan rules, scheduling and the scheduled job', async () => {
    const notInPlan = await app.put(`/api/v1/land-verification/${verificationId}/monitoring`).set(owner.auth).send({ enabled: true, frequency: 'DAILY' });
    expect(notInPlan.status).toBe(422);

    const enabled = await app.put(`/api/v1/land-verification/${verificationId}/monitoring`).set(owner.auth).send({ enabled: true, frequency: 'WEEKLY' });
    expect(enabled.status).toBe(200);
    expect(enabled.body.data.verification.monitoring).toMatchObject({ enabled: true, frequency: 'WEEKLY' });

    // Make it due and run the job.
    await prisma.landVerification.update({ where: { id: verificationId }, data: { nextVerificationAt: new Date(Date.now() - 1000) } });
    const summary = await recurringJob.run();
    expect(summary).toMatchObject({ claimed: 1, verified: 1, failed: 0 });

    const latest = await prisma.landRecordSnapshot.findFirst({ where: { landVerificationId: verificationId }, orderBy: { sequence: 'desc' } });
    expect(latest).toMatchObject({ sequence: 4, trigger: 'SCHEDULED', status: 'UNCHANGED' });
    const parcel = await prisma.landVerification.findUnique({ where: { id: verificationId } });
    const days = (parcel.nextVerificationAt.getTime() - latest.verifiedAt.getTime()) / 86400000;
    expect(days).toBeCloseTo(7, 5);
    expect(parcel.lockedUntil).toBeNull();

    // Not due -> nothing claimed.
    expect((await recurringJob.run()).claimed).toBe(0);
  });

  test('scheduled verification skips users whose subscription ended', async () => {
    await prisma.subscription.updateMany({ where: { userId: owner.user.id }, data: { endsAt: new Date(Date.now() - 1000) } });
    await prisma.landVerification.update({ where: { id: verificationId }, data: { nextVerificationAt: new Date(Date.now() - 1000) } });
    expect((await recurringJob.run()).claimed).toBe(0);

    // History stays readable, paid endpoints do not.
    expect((await app.get(`/api/v1/land-verification/${verificationId}/history`).set(owner.auth)).status).toBe(200);
    expect((await app.post('/api/v1/land-verification/punjab/verify').set(owner.auth).send(LOCATOR)).status).toBe(403);
    // Disabling monitoring never needs a subscription.
    expect((await app.put(`/api/v1/land-verification/${verificationId}/monitoring`).set(owner.auth).send({ enabled: false })).status).toBe(200);
  });
});
