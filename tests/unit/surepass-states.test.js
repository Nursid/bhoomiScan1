const { SurepassClient } = require('../../src/integrations/surepass/surepass.client');
const { SurepassLandProvider } = require('../../src/integrations/surepass/surepass-land.provider');
const { SurepassMaharashtraLandProvider } = require('../../src/integrations/surepass/surepass-maharashtra-land.provider');
const { SurepassBiharLandProvider } = require('../../src/integrations/surepass/surepass-bihar-land.provider');
const { createPunjabSurepassAdapter } = require('../../src/modules/land-verification/providers/punjab-surepass.adapter');
const { createMaharashtraSurepassAdapter } = require('../../src/modules/land-verification/providers/maharashtra-surepass.adapter');
const { createBiharSurepassAdapter } = require('../../src/modules/land-verification/providers/bihar-surepass.adapter');
const registry = require('../../src/modules/land-verification/providers/registry');
const metadataService = require('../../src/modules/land-verification/land-metadata.service');
const cache = require('../../src/utils/cache');
const logger = require('../../src/utils/logger');

const BASE = 'https://sandbox.surepass.test/api/v1/land-verification';

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const okFetch = (data = ['x']) => jest.fn(async () => jsonResponse(200, { success: true, status_code: 200, data }));

const make = (Provider, fetchImpl) => new Provider({ client: new SurepassClient({ fetchImpl }) });

/** The single upstream call: { url, method, body, authorization }. */
const lastCall = (fetchImpl) => {
  const [url, init] = fetchImpl.mock.calls.at(-1);
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, authorization: init.headers.authorization };
};

const PB = { district: 'amritsar', tehsil: 'ajnala', village: 'abu said', year: '2020 - 2021', khasra_number: '14//6/2---1' };
const MH = { district: 'पुणे', taluka: 'आंबेगाव', village: 'अडिवरे', survey_part_number: '1', survey_number: '1' };
const BR = { district: 'araria', anchal: 'araria', light: 'अररिया बस्ती', mouza: 'अररिया बस्ती - 214/1', plot_number: '1' };

describe('Punjab provider: endpoints and payloads (unchanged contract)', () => {
  const cases = [
    ['district list', (p) => p.getDistricts(), 'GET', '/punjab/meta/district-list', undefined],
    ['tehsil list', (p) => p.getTehsils('amritsar'), 'POST', '/punjab/meta/tehsil-list', { district: 'amritsar' }],
    ['village list', (p) => p.getVillages('amritsar', 'ajnala'), 'POST', '/punjab/meta/village-list', { district: 'amritsar', tehsil: 'ajnala' }],
    ['year list', (p) => p.getYears('amritsar', 'ajnala', 'abu said'), 'POST', '/punjab/meta/year-list', { district: 'amritsar', tehsil: 'ajnala', village: 'abu said' }],
    [
      'khasra number list',
      (p) => p.getKhasraNumbers('amritsar', 'ajnala', 'abu said', '2020 - 2021'),
      'POST',
      '/punjab/meta/khasra-number-list',
      { district: 'amritsar', tehsil: 'ajnala', village: 'abu said', year: '2020 - 2021' },
    ],
    ['verification', (p) => p.verifyPunjabLand(PB), 'POST', '/punjab', PB],
  ];

  test.each(cases)('%s', async (name, call, method, path, payload) => {
    const fetchImpl = okFetch(name === 'verification' ? { client_id: 'c1' } : ['x']);
    await call(make(SurepassLandProvider, fetchImpl));
    expect(lastCall(fetchImpl)).toEqual({ url: `${BASE}${path}`, method, body: payload, authorization: 'Bearer surepass-test-token' });
  });
});

describe('Maharashtra provider: endpoints and payloads', () => {
  const cases = [
    ['district list', (p) => p.getDistricts(), 'GET', '/maharashtra/meta/district-list', undefined],
    ['taluka list', (p) => p.getTalukas('पुणे'), 'POST', '/maharashtra/meta/taluka-list', { district: 'पुणे' }],
    ['village list', (p) => p.getVillages('पुणे', 'आंबेगाव'), 'POST', '/maharashtra/meta/village-list', { district: 'पुणे', taluka: 'आंबेगाव' }],
    [
      'survey number list',
      (p) => p.getSurveyNumbers('पुणे', 'आंबेगाव', 'अडिवरे', '1'),
      'POST',
      '/maharashtra/meta/survey-number-list',
      { district: 'पुणे', taluka: 'आंबेगाव', village: 'अडिवरे', survey_part_number: '1' },
    ],
    ['verification', (p) => p.verifyMaharashtraLand(MH), 'POST', '/maharashtra', MH],
  ];

  test.each(cases)('%s', async (name, call, method, path, payload) => {
    const fetchImpl = okFetch(name === 'verification' ? { client_id: 'c1' } : ['x']);
    await call(make(SurepassMaharashtraLandProvider, fetchImpl));
    expect(lastCall(fetchImpl)).toEqual({ url: `${BASE}${path}`, method, body: payload, authorization: 'Bearer surepass-test-token' });
  });

  test('verification never sends Punjab fields or anything beyond the locator', async () => {
    const fetchImpl = okFetch({ client_id: 'c1' });
    await make(SurepassMaharashtraLandProvider, fetchImpl).verifyMaharashtraLand({ ...MH, khasra_number: '9', tehsil: 'x', year: '2020 - 2021' });
    expect(Object.keys(lastCall(fetchImpl).body).sort()).toEqual(['district', 'survey_number', 'survey_part_number', 'taluka', 'village']);
  });
});

describe('Bihar provider: endpoints and payloads', () => {
  const cases = [
    ['district list', (p) => p.getDistricts(), 'GET', '/bihar/meta/district-list', undefined],
    ['anchal list', (p) => p.getAnchals('araria'), 'POST', '/bihar/meta/anchal-list', { district: 'araria' }],
    ['light list', (p) => p.getLights('araria', 'araria'), 'POST', '/bihar/meta/light-list', { district: 'araria', anchal: 'araria' }],
    [
      'mouza list',
      (p) => p.getMouzas('araria', 'araria', 'अररिया बस्ती'),
      'POST',
      '/bihar/meta/mouza-list',
      { district: 'araria', anchal: 'araria', light: 'अररिया बस्ती' },
    ],
    ['verification', (p) => p.verifyBiharLand(BR), 'POST', '/bihar', BR],
  ];

  test.each(cases)('%s', async (name, call, method, path, payload) => {
    const fetchImpl = okFetch(name === 'verification' ? { client_id: 'c1' } : ['x']);
    await call(make(SurepassBiharLandProvider, fetchImpl));
    expect(lastCall(fetchImpl)).toEqual({ url: `${BASE}${path}`, method, body: payload, authorization: 'Bearer surepass-test-token' });
  });

  test('verification sends exactly the Bihar locator fields', async () => {
    const fetchImpl = okFetch({ client_id: 'c1' });
    await make(SurepassBiharLandProvider, fetchImpl).verifyBiharLand({ ...BR, survey_number: '3', taluka: 'x' });
    expect(Object.keys(lastCall(fetchImpl).body).sort()).toEqual(['anchal', 'district', 'light', 'mouza', 'plot_number']);
  });
});

describe('shared client behaviour applies to every state', () => {
  test('401 -> SUREPASS_AUTH_FAILED (Maharashtra)', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(401, { success: false, message: 'Invalid token' }));
    await expect(make(SurepassMaharashtraLandProvider, fetchImpl).getTalukas('पुणे')).rejects.toMatchObject({ statusCode: 503, code: 'SUREPASS_AUTH_FAILED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('429 is retried for metadata (Bihar)', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(429, { success: false, message: 'Too many' }, { 'retry-after': '0' }));
    await expect(make(SurepassBiharLandProvider, fetchImpl).getAnchals('araria')).rejects.toMatchObject({ statusCode: 429, code: 'SUREPASS_RATE_LIMITED' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('verification is not retried on 5xx (Maharashtra, Bihar)', async () => {
    for (const [Provider, call] of [
      [SurepassMaharashtraLandProvider, (p) => p.verifyMaharashtraLand(MH)],
      [SurepassBiharLandProvider, (p) => p.verifyBiharLand(BR)],
    ]) {
      const fetchImpl = jest.fn(async () => jsonResponse(502, { message: 'bad gateway' }));
      await expect(call(make(Provider, fetchImpl))).rejects.toMatchObject({ statusCode: 503, code: 'SUREPASS_UNAVAILABLE' });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  test('HTTP 200 + success:false -> 422 with provider message (Bihar)', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { success: false, status_code: 422, message: 'Invalid light', message_code: 'bad_light' }));
    const error = await make(SurepassBiharLandProvider, fetchImpl).getMouzas('a', 'b', 'c').catch((e) => e);
    expect(error).toMatchObject({ statusCode: 422, code: 'SUREPASS_REJECTED_REQUEST', details: { providerMessage: 'Invalid light', providerCode: 'bad_light' } });
  });

  test('upstream 404 / 403 / 500 / timeout / network error map to application errors', async () => {
    const run = (fetchImpl) => make(SurepassMaharashtraLandProvider, fetchImpl).verifyMaharashtraLand(MH).catch((e) => e);
    expect(await run(jest.fn(async () => jsonResponse(404, { success: false, message: 'missing' })))).toMatchObject({ statusCode: 404, code: 'LAND_RECORD_NOT_FOUND' });
    expect(await run(jest.fn(async () => jsonResponse(403, { success: false })))).toMatchObject({ statusCode: 503, code: 'SUREPASS_AUTH_FAILED' });
    expect(await run(jest.fn(async () => jsonResponse(500, {})))).toMatchObject({ statusCode: 503, code: 'SUREPASS_UNAVAILABLE' });
    expect(await run(jest.fn().mockRejectedValue(new TypeError('fetch failed')))).toMatchObject({ statusCode: 502, code: 'SUREPASS_UNREACHABLE' });
    const hang = jest.fn((url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    expect(await run(hang)).toMatchObject({ statusCode: 504, code: 'SUREPASS_TIMEOUT' });
  });

  test('malformed (non-JSON) response is an error, not a crash', async () => {
    const fetchImpl = jest.fn(async () => new Response('<html>gateway</html>', { status: 502 }));
    await expect(make(SurepassBiharLandProvider, fetchImpl).getDistricts()).rejects.toMatchObject({ code: 'SUREPASS_UNAVAILABLE' });
  });

  test('unexpected metadata shape -> [] and a warning with the shape only, no values', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const fetchImpl = jest.fn(async () => jsonResponse(200, { success: true, data: { message: 'secret-owner-name' } }));
    await expect(make(SurepassMaharashtraLandProvider, fetchImpl).getDistricts()).resolves.toEqual([]);
    const [fields, message] = warn.mock.calls.find(([, msg]) => msg === 'unexpected surepass metadata response shape');
    expect(message).toBeDefined();
    expect(fields).toMatchObject({ state: 'maharashtra', operation: 'maharashtra.districts', shape: { success: 'boolean', data: { message: 'string' } } });
    expect(JSON.stringify(fields)).not.toContain('secret-owner-name');
    warn.mockRestore();
  });

  test('provider-call log lines carry state/operation/endpoint/status/duration but never the token', async () => {
    const info = jest.spyOn(logger, 'info');
    await make(SurepassBiharLandProvider, okFetch()).getLights('araria', 'araria');
    const [fields] = info.mock.calls.find(([, msg]) => msg === 'provider call ok');
    expect(fields).toMatchObject({ provider: 'SUREPASS', state: 'bihar', operation: 'bihar.lights', endpoint: '/api/v1/land-verification/bihar/meta/light-list', status: 200, success: true });
    expect(typeof fields.durationMs).toBe('number');
    expect(JSON.stringify(info.mock.calls)).not.toContain('surepass-test-token');
    info.mockRestore();
  });
});

describe('state adapters: request validation', () => {
  const punjab = createPunjabSurepassAdapter({ provider: {} });
  const maharashtra = createMaharashtraSurepassAdapter({ provider: {} });
  const bihar = createBiharSurepassAdapter({ provider: {} });
  const fieldsOf = (result) => result.error.issues.map((issue) => issue.path.join('.') || 'body');

  test('valid locators (incl. Devanagari and Surepass mouza format) are accepted', () => {
    expect(punjab.locatorSchema.safeParse(PB).success).toBe(true);
    expect(maharashtra.locatorSchema.safeParse(MH)).toMatchObject({ success: true, data: MH });
    expect(bihar.locatorSchema.safeParse(BR)).toMatchObject({ success: true, data: BR });
  });

  test('Punjab missing village is rejected', () => {
    const { village, ...rest } = PB;
    expect(fieldsOf(punjab.locatorSchema.safeParse(rest))).toEqual(['village']);
  });

  test('Maharashtra missing taluka is rejected', () => {
    const { taluka, ...rest } = MH;
    expect(fieldsOf(maharashtra.locatorSchema.safeParse(rest))).toEqual(['taluka']);
  });

  test('Bihar missing anchal is rejected', () => {
    const { anchal, ...rest } = BR;
    expect(fieldsOf(bihar.locatorSchema.safeParse(rest))).toEqual(['anchal']);
  });

  test('fields from another state are rejected (strict per-state contracts)', () => {
    expect(maharashtra.locatorSchema.safeParse({ ...MH, khasra_number: '1' }).success).toBe(false);
    expect(bihar.locatorSchema.safeParse({ ...BR, survey_number: '1' }).success).toBe(false);
    expect(punjab.locatorSchema.safeParse({ ...PB, taluka: 'x' }).success).toBe(false);
    // A Punjab payload is not a Maharashtra or Bihar payload.
    expect(maharashtra.locatorSchema.safeParse(PB).success).toBe(false);
    expect(bihar.locatorSchema.safeParse(PB).success).toBe(false);
  });

  test('blank or malicious values are rejected', () => {
    expect(maharashtra.locatorSchema.safeParse({ ...MH, survey_number: '   ' }).success).toBe(false);
    expect(bihar.locatorSchema.safeParse({ ...BR, light: '<script>' }).success).toBe(false);
    expect(bihar.locatorSchema.safeParse({ ...BR, plot_number: 5 }).success).toBe(false);
  });

  test('parcel identity and property id keep state terminology', () => {
    expect(maharashtra.propertyId({ ...MH, district: ' पुणे ' })).toBe('MH:पुणे:आंबेगाव:अडिवरे:1:1');
    expect(bihar.propertyId(BR)).toBe('BR:araria:araria:अररिया बस्ती:अररिया बस्ती - 214/1:1');
    expect(Object.keys(maharashtra.parcelIdentity(MH))).toEqual(['district', 'taluka', 'village', 'survey_part_number', 'survey_number']);
    expect(Object.keys(bihar.parcelIdentity(BR))).toEqual(['district', 'anchal', 'light', 'mouza', 'plot_number']);
  });

  test('normalizeRecord unwraps the Surepass envelope and drops noise', () => {
    const raw = { success: true, status_code: 200, data: { client_id: 'x', Owner_Name: '  राम  ', area: '1.50' } };
    expect(maharashtra.normalizeRecord(raw)).toEqual({ owner_name: 'राम', area: '1.5' });
    expect(bihar.normalizeRecord(raw)).toEqual({ owner_name: 'राम', area: '1.5' });
  });
});

describe('metadata dependency validation + caching', () => {
  const fakeAdapter = (factory) => {
    const adapter = factory({ provider: {} });
    adapter.listOptions = jest.fn(async () => [{ value: 'v', label: 'v' }]);
    return adapter;
  };

  beforeEach(() => cache.clear());

  test.each([
    ['maharashtra', createMaharashtraSurepassAdapter, 'villages', { district: 'पुणे' }, 'taluka'],
    ['maharashtra', createMaharashtraSurepassAdapter, 'survey-numbers', { district: 'पुणे', taluka: 'आंबेगाव', village: 'अडिवरे' }, 'survey_part_number'],
    ['bihar', createBiharSurepassAdapter, 'lights', { district: 'araria' }, 'anchal'],
    ['bihar', createBiharSurepassAdapter, 'mouzas', { district: 'araria', anchal: 'araria' }, 'light'],
    ['punjab', createPunjabSurepassAdapter, 'years', { district: 'amritsar', tehsil: 'ajnala' }, 'village'],
  ])('%s %s without %s is rejected before any provider call', async (state, factory, level, body, missing) => {
    const adapter = fakeAdapter(factory);
    const error = await metadataService.listOptions(adapter, level, body).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 422, code: 'VALIDATION_FAILED' });
    expect(error.details.map((d) => d.field)).toEqual([missing]);
    expect(adapter.listOptions).not.toHaveBeenCalled();
  });

  test('cache keys include every parent filter', async () => {
    const adapter = fakeAdapter(createMaharashtraSurepassAdapter);
    const filters = { district: 'पुणे', taluka: 'आंबेगाव', village: 'अडिवरे', survey_part_number: '1' };
    expect((await metadataService.listOptions(adapter, 'survey-numbers', filters)).cached).toBe(false);
    expect((await metadataService.listOptions(adapter, 'survey-numbers', filters)).cached).toBe(true);
    expect((await metadataService.listOptions(adapter, 'survey-numbers', { ...filters, survey_part_number: '2' })).cached).toBe(false);
    expect(adapter.listOptions).toHaveBeenCalledTimes(2);
  });

  test('the same level name in two states never shares a cache entry', async () => {
    const mh = fakeAdapter(createMaharashtraSurepassAdapter);
    const br = fakeAdapter(createBiharSurepassAdapter);
    await metadataService.listOptions(mh, 'districts', {});
    expect((await metadataService.listOptions(br, 'districts', {})).cached).toBe(false);
  });
});

describe('registry', () => {
  test('lists the three states with state-specific form fields in drill-down order', () => {
    const states = Object.fromEntries(registry.listStates().map((state) => [state.slug, state]));
    expect(states.punjab.fields.map((f) => f.name)).toEqual(['district', 'tehsil', 'village', 'year', 'khasra_number']);
    expect(states.maharashtra.fields.map((f) => f.name)).toEqual(['district', 'taluka', 'village', 'survey_part_number', 'survey_number']);
    expect(states.bihar.fields.map((f) => f.name)).toEqual(['district', 'anchal', 'light', 'mouza', 'plot_number']);
    expect(states.maharashtra.fields[4]).toMatchObject({
      input: 'select',
      dependsOn: ['district', 'taluka', 'village', 'survey_part_number'],
      options: { method: 'POST', path: '/api/v1/land-verification/maharashtra/survey-numbers', body: ['district', 'taluka', 'village', 'survey_part_number'] },
    });
    expect(states.bihar.fields[4]).toMatchObject({ name: 'plot_number', input: 'text' });
    expect(JSON.stringify(states)).not.toContain('surepass-test-token');
  });

  test('every select field points at a metadata level whose filters are exactly the previous fields', () => {
    for (const state of registry.listStates()) {
      const adapter = registry.getAdapter(state.slug);
      state.fields.forEach((field, index) => {
        if (!field.source) return;
        expect(adapter.metadataLevels[field.source].filters).toEqual(state.fields.slice(0, index).map((f) => f.name));
      });
    }
  });
});
