/**
 * State-specific land verification over HTTP: Punjab, Maharashtra and Bihar each
 * drive their own hierarchy, Surepass endpoints and payloads. Surepass is faked
 * at the fetch level, so the exact upstream URL + JSON body is asserted.
 */

const { prisma, resetDb, installFetch, api, login, giveActiveSubscription, settle } = require('./helpers');

const SP = 'https://sandbox\\.surepass\\.test/api/v1/land-verification';
const LV = '/api/v1/land-verification';

const PB = { district: 'amritsar', tehsil: 'ajnala', village: 'abu said', year: '2020 - 2021', khasra_number: '14//6/2---1' };
const MH = { district: 'पुणे', taluka: 'आंबेगाव', village: 'अडिवरे', survey_part_number: '1', survey_number: '1' };
const BR = { district: 'araria', anchal: 'araria', light: 'अररिया बस्ती', mouza: 'अररिया बस्ती - 214/1', plot_number: '1' };

const list = (data) => ({ body: { success: true, status_code: 200, data } });
const record = (data) => ({ body: { success: true, status_code: 200, message_code: 'success', data: { client_id: `land_${Math.random().toString(36).slice(2)}`, ...data } } });

let fake;

beforeAll(async () => {
  await resetDb();
  fake = installFetch();
  // Punjab
  fake.on('GET', new RegExp(`${SP}/punjab/meta/district-list$`), list(['Amritsar']));
  fake.on('POST', new RegExp(`${SP}/punjab/meta/tehsil-list$`), list(['Ajnala']));
  fake.on('POST', new RegExp(`${SP}/punjab/meta/village-list$`), list(['Abu Said']));
  fake.on('POST', new RegExp(`${SP}/punjab/meta/year-list$`), list(['2020 - 2021']));
  fake.on('POST', new RegExp(`${SP}/punjab/meta/khasra-number-list$`), list(['14//6/2---1']));
  fake.on('POST', new RegExp(`${SP}/punjab$`), record({ owner_details: [{ owner_name: 'Gurpreet Singh' }], area: '0-12-5' }));
  // Maharashtra (response shape differs on purpose: wrapped list of objects)
  fake.on('GET', new RegExp(`${SP}/maharashtra/meta/district-list$`), list({ district_list: [{ name: 'पुणे' }, { name: 'सातारा' }] }));
  fake.on('POST', new RegExp(`${SP}/maharashtra/meta/taluka-list$`), list(['आंबेगाव']));
  fake.on('POST', new RegExp(`${SP}/maharashtra/meta/village-list$`), list(['अडिवरे']));
  fake.on('POST', new RegExp(`${SP}/maharashtra/meta/survey-number-list$`), list(['1', '2']));
  fake.on('POST', new RegExp(`${SP}/maharashtra$`), (url, init, body) =>
    body.survey_number === '404'
      ? { status: 200, body: { success: false, status_code: 422, message: 'Invalid survey number', message_code: 'invalid_survey' } }
      : record({ owner_name: 'राम पाटील', total_area: '1.20', survey_no: '1' }),
  );
  // Bihar
  fake.on('GET', new RegExp(`${SP}/bihar/meta/district-list$`), list(['araria']));
  fake.on('POST', new RegExp(`${SP}/bihar/meta/anchal-list$`), list(['araria']));
  fake.on('POST', new RegExp(`${SP}/bihar/meta/light-list$`), list(['अररिया बस्ती']));
  fake.on('POST', new RegExp(`${SP}/bihar/meta/mouza-list$`), list(['अररिया बस्ती - 214/1']));
  fake.on('POST', new RegExp(`${SP}/bihar$`), record({ raiyat_name: 'सीता देवी', khata_no: '12', rakba: '0.25' }));
  fake.on('POST', /^https:\/\/contracts\.test\/records$/, () => ({ status: 201, body: { id: `sc_${Math.random()}`, transactionHash: `0x${'1'.padStart(64, '0')}` } }));
});

afterAll(async () => {
  fake.restore();
  await settle();
  await prisma.$disconnect();
});

describe('state-specific land verification', () => {
  let app;
  let user;

  /** Last upstream call to a Surepass path suffix, e.g. "/bihar/meta/light-list". */
  const upstream = (suffix) => fake.callsTo(new RegExp(`${SP}${suffix.replace(/\//g, '\\/')}$`)).at(-1);
  const surepassCallCount = () => fake.callsTo(/surepass\.test/).length;

  beforeAll(async () => {
    app = api();
    user = await login(app, '9833333333');
    await giveActiveSubscription(user.user.id, 'quarterly');
  });

  test('GET /states describes each state with its own fields', async () => {
    const res = await app.get(`${LV}/states`).set(user.auth);
    expect(res.status).toBe(200);
    const states = Object.fromEntries(res.body.data.states.map((s) => [s.slug, s.fields.map((f) => f.name)]));
    expect(states).toEqual({
      punjab: ['district', 'tehsil', 'village', 'year', 'khasra_number'],
      maharashtra: ['district', 'taluka', 'village', 'survey_part_number', 'survey_number'],
      bihar: ['district', 'anchal', 'light', 'mouza', 'plot_number'],
    });
  });

  describe('Punjab (existing contract)', () => {
    test.each([
      ['districts', 'GET', undefined, '/punjab/meta/district-list'],
      ['tehsils', 'POST', { district: 'amritsar' }, '/punjab/meta/tehsil-list'],
      ['villages', 'POST', { district: 'amritsar', tehsil: 'ajnala' }, '/punjab/meta/village-list'],
      ['years', 'POST', { district: 'amritsar', tehsil: 'ajnala', village: 'abu said' }, '/punjab/meta/year-list'],
      ['khasras', 'POST', { district: 'amritsar', tehsil: 'ajnala', village: 'abu said', year: '2020 - 2021' }, '/punjab/meta/khasra-number-list'],
    ])('%s', async (level, method, body, upstreamPath) => {
      const req = method === 'GET' ? app.get(`${LV}/punjab/${level}`) : app.post(`${LV}/punjab/${level}`).send(body);
      const res = await req.set(user.auth);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ state: 'punjab', level, count: 1 });
      const call = upstream(upstreamPath);
      expect(call.body).toEqual(body);
      expect(call.headers.authorization).toBe('Bearer surepass-test-token');
    });

    test('verify sends the Punjab payload unchanged', async () => {
      const res = await app.post(`${LV}/punjab/verify`).set(user.auth).send(PB);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'VERIFIED', source: { state: 'PUNJAB', provider: 'SUREPASS' } });
      expect(upstream('/punjab').body).toEqual(PB);
    });
  });

  describe('Maharashtra', () => {
    test.each([
      ['districts', 'GET', undefined, '/maharashtra/meta/district-list', ['पुणे', 'सातारा']],
      ['talukas', 'POST', { district: 'पुणे' }, '/maharashtra/meta/taluka-list', ['आंबेगाव']],
      ['villages', 'POST', { district: 'पुणे', taluka: 'आंबेगाव' }, '/maharashtra/meta/village-list', ['अडिवरे']],
      [
        'survey-numbers',
        'POST',
        { district: 'पुणे', taluka: 'आंबेगाव', village: 'अडिवरे', survey_part_number: '1' },
        '/maharashtra/meta/survey-number-list',
        ['1', '2'],
      ],
    ])('%s', async (level, method, body, upstreamPath, values) => {
      const req = method === 'GET' ? app.get(`${LV}/maharashtra/${level}`) : app.post(`${LV}/maharashtra/${level}`).send(body);
      const res = await req.set(user.auth);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ state: 'maharashtra', level, cached: false });
      expect(res.body.data.options.map((o) => o.value)).toEqual(values);
      expect(upstream(upstreamPath).body).toEqual(body);
    });

    test('verify sends the Maharashtra payload and stores a Maharashtra parcel', async () => {
      const res = await app.post(`${LV}/maharashtra/verify`).set(user.auth).send(MH);
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data).toMatchObject({ status: 'VERIFIED', snapshotStatus: 'INITIAL', source: { state: 'MAHARASHTRA', provider: 'SUREPASS' } });
      expect(data.record).toMatchObject({ owner_name: 'राम पाटील', total_area: '1.2' });
      expect(upstream('/maharashtra').body).toEqual(MH);

      const parcel = await prisma.landVerification.findUnique({ where: { id: data.verificationId } });
      expect(parcel).toMatchObject({ stateCode: 'MAHARASHTRA', locator: MH, displayName: 'Survey 1 (part 1), अडिवरे, आंबेगाव, पुणे' });
      const snapshot = await prisma.landRecordSnapshot.findUnique({ where: { id: data.currentVerification } });
      expect(snapshot.rawResponse.data.owner_name).toBe('राम पाटील'); // provider response preserved as-is
      const sc = await prisma.smartContractRecord.findUnique({ where: { snapshotId: snapshot.id } });
      expect(sc.propertyId).toBe('MH:पुणे:आंबेगाव:अडिवरे:1:1');

      // Re-verify -> same parcel, UNCHANGED.
      const again = await app.post(`${LV}/maharashtra/verify`).set(user.auth).send(MH);
      expect(again.body.data).toMatchObject({ verificationId: data.verificationId, status: 'UNCHANGED' });
    });

    test('provider rejection is returned as a meaningful error', async () => {
      const res = await app.post(`${LV}/maharashtra/verify`).set(user.auth).send({ ...MH, survey_number: '404' });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatchObject({ code: 'SUREPASS_REJECTED_REQUEST', details: { providerMessage: 'Invalid survey number' } });
    });
  });

  describe('Bihar', () => {
    test.each([
      ['districts', 'GET', undefined, '/bihar/meta/district-list'],
      ['anchals', 'POST', { district: 'araria' }, '/bihar/meta/anchal-list'],
      ['lights', 'POST', { district: 'araria', anchal: 'araria' }, '/bihar/meta/light-list'],
      ['mouzas', 'POST', { district: 'araria', anchal: 'araria', light: 'अररिया बस्ती' }, '/bihar/meta/mouza-list'],
    ])('%s', async (level, method, body, upstreamPath) => {
      const req = method === 'GET' ? app.get(`${LV}/bihar/${level}`) : app.post(`${LV}/bihar/${level}`).send(body);
      const res = await req.set(user.auth);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ state: 'bihar', level, count: 1 });
      expect(upstream(upstreamPath).body).toEqual(body);
    });

    test('verify sends the Bihar payload ("light" verbatim) and stores a Bihar parcel', async () => {
      const res = await app.post(`${LV}/bihar/verify`).set(user.auth).send(BR);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'VERIFIED', source: { state: 'BIHAR' }, record: { raiyat_name: 'सीता देवी', khata_no: '12' } });
      expect(upstream('/bihar').body).toEqual(BR);
      const parcel = await prisma.landVerification.findUnique({ where: { id: res.body.data.verificationId } });
      expect(parcel).toMatchObject({ stateCode: 'BIHAR', locator: BR });
    });
  });

  describe('invalid requests never reach Surepass', () => {
    test.each([
      ['Maharashtra villages missing taluka', 'post', '/maharashtra/villages', { district: 'पुणे' }, ['taluka']],
      ['Maharashtra survey numbers missing survey_part_number', 'post', '/maharashtra/survey-numbers', { district: 'पुणे', taluka: 'आंबेगाव', village: 'अडिवरे' }, ['survey_part_number']],
      ['Maharashtra verify missing taluka', 'post', '/maharashtra/verify', (({ taluka, ...rest }) => rest)(MH), ['taluka']],
      ['Maharashtra verify with Punjab fields', 'post', '/maharashtra/verify', { ...MH, khasra_number: '1' }, ['body']],
      ['Bihar lights missing anchal', 'post', '/bihar/lights', { district: 'araria' }, ['anchal']],
      ['Bihar verify missing anchal', 'post', '/bihar/verify', (({ anchal, ...rest }) => rest)(BR), ['anchal']],
      ['Bihar verify with survey_number', 'post', '/bihar/verify', { ...BR, survey_number: '1' }, ['body']],
      ['Punjab years missing village', 'post', '/punjab/years', { district: 'amritsar', tehsil: 'ajnala' }, ['village']],
      ['Punjab verify missing village', 'post', '/punjab/verify', (({ village, ...rest }) => rest)(PB), ['village']],
    ])('%s -> 422', async (name, method, path, body, fields) => {
      const before = surepassCallCount();
      const res = await app[method](`${LV}${path}`).set(user.auth).send(body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.map((d) => d.field)).toEqual(fields);
      expect(surepassCallCount()).toBe(before);
    });

    test.each([
      ['Punjab level on Maharashtra', 'post', '/maharashtra/tehsils'],
      ['Punjab level on Bihar', 'post', '/bihar/khasras'],
      ['Maharashtra level on Bihar', 'post', '/bihar/talukas'],
      ['Bihar level on Punjab', 'post', '/punjab/mouzas'],
      ['district list via POST', 'post', '/maharashtra/districts'],
      ['prototype key as level', 'post', '/bihar/constructor'],
    ])('%s -> 404 METADATA_LEVEL_NOT_FOUND', async (name, method, path) => {
      const before = surepassCallCount();
      const res = await app[method](`${LV}${path}`).set(user.auth).send({ district: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('METADATA_LEVEL_NOT_FOUND');
      expect(surepassCallCount()).toBe(before);
    });

    test('unknown state -> 404 STATE_NOT_SUPPORTED', async () => {
      const res = await app.post(`${LV}/kerala/talukas`).set(user.auth).send({ district: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('STATE_NOT_SUPPORTED');
    });

    test('metadata needs authentication', async () => {
      expect((await app.get(`${LV}/bihar/districts`)).status).toBe(401);
    });
  });

  test('the Surepass token never appears in any response or audit row', async () => {
    const responses = await Promise.all([
      app.get(`${LV}/states`).set(user.auth),
      app.get(`${LV}/bihar/districts`).set(user.auth),
      app.post(`${LV}/maharashtra/verify`).set(user.auth).send({ ...MH, survey_number: '404' }),
    ]);
    for (const res of responses) {
      expect(JSON.stringify(res.body)).not.toContain('surepass-test-token');
      expect(JSON.stringify(res.headers)).not.toContain('surepass-test-token');
    }
    await settle();
    const logs = await prisma.apiRequestLog.findMany({ where: { provider: 'SUREPASS' } });
    expect(logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(logs)).not.toContain('surepass-test-token');
    const operations = logs.map((log) => log.operation);
    expect(operations).toEqual(expect.arrayContaining(['punjab.verify', 'maharashtra.survey-numbers', 'maharashtra.verify', 'bihar.lights', 'bihar.verify']));
  });
});
