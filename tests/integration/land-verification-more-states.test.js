/**
 * The ten declarative Surepass states over HTTP: every drill-down list and the
 * verify call, with the documented payloads. Surepass is faked at the fetch
 * level, so the exact upstream URL + JSON body is asserted.
 */

const { prisma, resetDb, installFetch, api, login, giveActiveSubscription, settle } = require('./helpers');

const SP = 'https://sandbox\\.surepass\\.test/api/v1/land-verification';
const LV = '/api/v1/land-verification';

const TR = 'উত্তর ত্রিপুরা/north tripura';
const PS = 'পানিসাগর/panisagar';

// state -> { levels: [[level, body, surepass list]], verify, stateCode, record }
const STATES = {
  gujarat: {
    stateCode: 'GUJARAT',
    levels: [
      ['districts', undefined, 'district-list'],
      ['talukas', { district: 'sabarkantha' }, 'taluka-list'],
      ['villages', { district: 'sabarkantha', taluka: 'prantij' }, 'village-list'],
      ['blocks', { district: 'sabarkantha', taluka: 'prantij', village: 'kamalpur' }, 'block-list'],
    ],
    verify: { district: 'sabarkantha', taluka: 'prantij', village: 'kamalpur', block: '14', owner_name: 'SHANUBHAI' },
  },
  'madhya-pradesh': {
    stateCode: 'MADHYA_PRADESH',
    levels: [
      ['districts', undefined, 'district-list'],
      ['tehsils', { district: 'datia' }, 'tehsil-list'],
      ['villages', { district: 'datia', tehsil: 'seondha' }, 'village-list'],
      ['khasras', { district: 'datia', tehsil: 'seondha', village: 'badokhari' }, 'khasra-list'],
    ],
    verify: { district: 'datia', tehsil: 'seondha', village: 'badokhari', khasra: '48' },
  },
  uttarakhand: {
    stateCode: 'UTTARAKHAND',
    levels: [
      ['districts', undefined, 'district-list'],
      ['tehsils', { district: 'almora' }, 'tehsil-list'],
      ['villages', { district: 'almora', tehsil: 'syalde' }, 'village-list'],
      ['years', { district: 'almora', tehsil: 'syalde', village: 'ataliya' }, 'year-list'],
      ['khatas', { district: 'almora', tehsil: 'syalde', village: 'ataliya', year: '1411-1416' }, 'khata-list'],
    ],
    verify: { district: 'almora', tehsil: 'syalde', village: 'ataliya', year: '1411-1416', khata: '00001' },
  },
  delhi: {
    stateCode: 'DELHI',
    levels: [
      ['districts', undefined, 'district-list'],
      ['tehsils', { district: 'south_west' }, 'tehsil-list'],
      ['villages', { district: 'south_west', tehsil: 'najafgarh' }, 'village-list'],
      ['khata-numbers', { district: 'south_west', tehsil: 'najafgarh', village: 'bakargarh' }, 'khata-number-list'],
    ],
    verify: { district: 'south_west', tehsil: 'najafgarh', village: 'bakargarh', khata_no: '3' },
  },
  'andaman-and-nicobar': {
    stateCode: 'ANDAMAN_AND_NICOBAR',
    levels: [
      ['districts', undefined, 'district-list'],
      ['tehsils', { district: 'south_andaman' }, 'tehsil-list'],
      ['villages', { district: 'south_andaman', tehsil: 'sri_vijaya_puram' }, 'village-list'],
      ['survey-numbers', { district: 'south_andaman', tehsil: 'sri_vijaya_puram', village: 'brich_gunj' }, 'survey-number-list'],
    ],
    verify: { district: 'south_andaman', tehsil: 'sri_vijaya_puram', village: 'brich_gunj', survey_number: '1' },
  },
  goa: {
    stateCode: 'GOA',
    levels: [
      ['districts', undefined, 'district-list'],
      ['talukas', { district: 'kushavati' }, 'taluka-list'],
      ['villages', { district: 'kushavati', taluka: 'canacona' }, 'village-list'],
      ['survey-numbers', { district: 'kushavati', taluka: 'canacona', village: 'agonda' }, 'survey-number-list'],
      ['subdivision-numbers', { district: 'kushavati', taluka: 'canacona', village: 'agonda', survey_number: '28' }, 'subdivision-number-list'],
    ],
    verify: { district: 'kushavati', taluka: 'canacona', village: 'agonda', survey_number: '28', subdivision_number: '1' },
  },
  chhattisgarh: {
    stateCode: 'CHHATTISGARH',
    levels: [
      ['districts', undefined, 'district-list'],
      ['tehsils', { district: 'कबीरधाम' }, 'tehsil-list'],
      ['villages', { district: 'कबीरधाम', tehsil: 'कुकदूर' }, 'village-list'],
    ],
    verify: { district: 'कबीरधाम', tehsil: 'कुकदूर', village: 'अंजबाइनबांह (00014) - 5702052', khasra_number: '10' },
  },
  telangana: {
    stateCode: 'TELANGANA',
    levels: [
      ['districts', undefined, 'district-list'],
      ['mandals', { district: 'adilabad' }, 'mandal-list'],
      ['villages', { district: 'adilabad', mandal: 'adilabad (rural)' }, 'village-list'],
      ['survey-numbers', { district: 'adilabad', mandal: 'adilabad (rural)', village: 'ankapoor' }, 'survey-number-list'],
      ['khata-numbers', { district: 'adilabad', mandal: 'adilabad (rural)', village: 'ankapoor', survey_number: '2/1' }, 'khata-number-list'],
    ],
    verify: { district: 'adilabad', mandal: 'adilabad (rural)', village: 'ankapoor', survey_number: '2/1', khata_number: '1' },
  },
  sikkim: {
    stateCode: 'SIKKIM',
    levels: [
      ['districts', undefined, 'district-list'],
      ['subdivisions', { district: 'gangtok district' }, 'subdivision-list'],
      ['revenue-circles', { district: 'gangtok district', subdivision: 'gangtok sub-divison' }, 'revenue-circle-list'],
      ['revenue-blocks', { district: 'gangtok district', subdivision: 'gangtok sub-divison', revenue_circle: 'sichey revenue circle' }, 'revenue-block-list'],
    ],
    verify: { district: 'gangtok district', subdivision: 'gangtok sub-divison', revenue_circle: 'sichey revenue circle', revenue_block: 'rongyek', plot_number: '123' },
  },
  tripura: {
    stateCode: 'TRIPURA',
    levels: [
      ['districts', undefined, 'district-list'],
      ['subdivisions', { district: TR }, 'subdivision-list'],
      ['revenue-circles', { district: TR, subdivision: PS }, 'revenue-circle-list'],
      ['tehsils', { district: TR, subdivision: PS, revenue_circle: PS }, 'tehsil-list'],
      ['moujas', { district: TR, subdivision: PS, revenue_circle: PS, tehsil: PS }, 'mouja-list'],
    ],
    verify: { district: TR, subdivision: PS, revenue_circle: PS, tehsil: PS, mouja: PS, khatian_number: '2885' },
  },
};

const LEVEL_CASES = Object.entries(STATES).flatMap(([slug, { levels }]) => levels.map(([level, body, list]) => [slug, level, body, list]));
const VERIFY_CASES = Object.entries(STATES).map(([slug, state]) => [slug, state]);

let fake;

beforeAll(async () => {
  await resetDb();
  fake = installFetch();
  for (const [slug, level, body, list] of LEVEL_CASES) {
    fake.on(body ? 'POST' : 'GET', new RegExp(`${SP}/${slug}/meta/${list}$`), { body: { success: true, status_code: 200, data: [`${level}-a`, { name: `${level}-b` }] } });
  }
  for (const slug of Object.keys(STATES)) {
    fake.on('POST', new RegExp(`${SP}/${slug}$`), (url, init, body) =>
      Object.values(body).includes('404')
        ? { status: 200, body: { success: false, status_code: 404, message: 'No record found', message_code: 'not_found' } }
        : { body: { success: true, status_code: 200, message_code: 'success', data: { client_id: `land_${Math.random().toString(36).slice(2)}`, owner_name: 'Owner', area: '1.20' } } },
    );
  }
  fake.on('POST', /^https:\/\/contracts\.test\/records$/, () => ({ status: 201, body: { id: `sc_${Math.random()}`, transactionHash: `0x${'2'.padStart(64, '0')}` } }));
});

afterAll(async () => {
  fake.restore();
  await settle();
  await prisma.$disconnect();
});

describe('more Surepass states', () => {
  let app;
  let user;

  const upstream = (suffix) => fake.callsTo(new RegExp(`${SP}${suffix.replace(/\//g, '\\/')}$`)).at(-1);
  const surepassCallCount = () => fake.callsTo(/surepass\.test/).length;

  beforeAll(async () => {
    app = api();
    user = await login(app, '9844444444');
    await giveActiveSubscription(user.user.id, 'quarterly');
  });

  test('GET /states lists all 13 states with their own fields', async () => {
    const res = await app.get(`${LV}/states`).set(user.auth);
    expect(res.status).toBe(200);
    const states = Object.fromEntries(res.body.data.states.map((s) => [s.slug, s]));
    expect(Object.keys(states)).toHaveLength(13);
    for (const [slug, { verify }] of VERIFY_CASES) {
      expect(states[slug].fields.map((f) => f.name)).toEqual(Object.keys(verify));
      expect(states[slug].verify).toEqual({ method: 'POST', path: `${LV}/${slug}/verify` });
    }
  });

  test.each(LEVEL_CASES)('%s %s', async (slug, level, body, list) => {
    const req = body ? app.post(`${LV}/${slug}/${level}`).send(body) : app.get(`${LV}/${slug}/${level}`);
    const res = await req.set(user.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: slug, level, count: 2, cached: false });
    expect(res.body.data.options.map((o) => o.value)).toEqual([`${level}-a`, `${level}-b`]);
    const call = upstream(`/${slug}/meta/${list}`);
    expect(call.body).toEqual(body);
    expect(call.headers.authorization).toBe('Bearer surepass-test-token');
  });

  test.each(VERIFY_CASES)('%s verify sends the documented payload and stores the parcel', async (slug, { verify, stateCode }) => {
    const res = await app.post(`${LV}/${slug}/verify`).set(user.auth).send(verify);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'VERIFIED', snapshotStatus: 'INITIAL', source: { state: stateCode, provider: 'SUREPASS' }, record: { owner_name: 'owner' } }); // normalized form
    expect(upstream(`/${slug}`).body).toEqual(verify);
    const parcel = await prisma.landVerification.findUnique({ where: { id: res.body.data.verificationId } });
    expect(parcel).toMatchObject({ stateCode, locator: verify });

    const again = await app.post(`${LV}/${slug}/verify`).set(user.auth).send(verify);
    expect(again.body.data).toMatchObject({ verificationId: res.body.data.verificationId, status: 'UNCHANGED' });
  });

  test('provider "not found" is a meaningful 404', async () => {
    const res = await app.post(`${LV}/goa/verify`).set(user.auth).send({ ...STATES.goa.verify, subdivision_number: '404' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('LAND_RECORD_NOT_FOUND');
  });

  describe('invalid requests never reach Surepass', () => {
    test.each([
      ['Gujarat verify without owner_name', '/gujarat/verify', (({ owner_name, ...rest }) => rest)(STATES.gujarat.verify), ['owner_name']],
      ['Goa subdivision list without survey_number', '/goa/subdivision-numbers', { district: 'kushavati', taluka: 'canacona', village: 'agonda' }, ['survey_number']],
      ['Telangana villages without mandal', '/telangana/villages', { district: 'adilabad' }, ['mandal']],
      ['Tripura moujas without tehsil', '/tripura/moujas', { district: TR, subdivision: PS, revenue_circle: PS }, ['tehsil']],
      ['MP verify with khasra_number instead of khasra', '/madhya-pradesh/verify', { district: 'datia', tehsil: 'seondha', village: 'badokhari', khasra_number: '48' }, ['khasra', 'body']],
      ['Sikkim verify with blank plot_number', '/sikkim/verify', { ...STATES.sikkim.verify, plot_number: ' ' }, ['plot_number', 'plot_number']],
    ])('%s -> 422', async (name, path, body, fields) => {
      const before = surepassCallCount();
      const res = await app.post(`${LV}${path}`).set(user.auth).send(body);
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.map((d) => d.field)).toEqual(fields);
      expect(surepassCallCount()).toBe(before);
    });

    test.each([
      ['Chhattisgarh has no khasra list (khasra_number is typed)', '/chhattisgarh/khasra-numbers'],
      ['Punjab level on Telangana', '/telangana/tehsils'],
      ['Sikkim has no plot list', '/sikkim/plot-numbers'],
    ])('%s -> 404', async (name, path) => {
      const res = await app.post(`${LV}${path}`).set(user.auth).send({ district: 'x' });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('METADATA_LEVEL_NOT_FOUND');
    });
  });
});
