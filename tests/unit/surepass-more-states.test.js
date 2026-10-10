/**
 * The ten declarative Surepass states (surepass-state-adapter.js). Every case
 * uses the exact payloads of the Surepass cURL documentation, and asserts the
 * exact upstream URL, method, JSON body and auth header.
 */

const { SurepassClient } = require('../../src/integrations/surepass/surepass.client');
const { SurepassStateLandProvider } = require('../../src/integrations/surepass/surepass-land.base');
const registry = require('../../src/modules/land-verification/providers/registry');
const metadataService = require('../../src/modules/land-verification/land-metadata.service');
const cache = require('../../src/utils/cache');

const BASE = 'https://sandbox.surepass.test/api/v1/land-verification';

const jsonResponse = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const okFetch = (data) => jest.fn(async () => jsonResponse(200, { success: true, status_code: 200, data }));

/** Adapter from the registry's factory, wired to a fetch-level fake. */
const adapterWith = (slug, fetchImpl) => {
  const { stateCode } = registry.getAdapter(slug);
  const factory = FACTORIES[stateCode];
  return factory({ provider: new SurepassStateLandProvider({ state: slug, client: new SurepassClient({ fetchImpl }) }) });
};

const FACTORIES = {
  GUJARAT: require('../../src/modules/land-verification/providers/gujarat-surepass.adapter').createGujaratSurepassAdapter,
  MADHYA_PRADESH: require('../../src/modules/land-verification/providers/madhya-pradesh-surepass.adapter').createMadhyaPradeshSurepassAdapter,
  UTTARAKHAND: require('../../src/modules/land-verification/providers/uttarakhand-surepass.adapter').createUttarakhandSurepassAdapter,
  DELHI: require('../../src/modules/land-verification/providers/delhi-surepass.adapter').createDelhiSurepassAdapter,
  ANDAMAN_AND_NICOBAR: require('../../src/modules/land-verification/providers/andaman-and-nicobar-surepass.adapter').createAndamanAndNicobarSurepassAdapter,
  GOA: require('../../src/modules/land-verification/providers/goa-surepass.adapter').createGoaSurepassAdapter,
  CHHATTISGARH: require('../../src/modules/land-verification/providers/chhattisgarh-surepass.adapter').createChhattisgarhSurepassAdapter,
  TELANGANA: require('../../src/modules/land-verification/providers/telangana-surepass.adapter').createTelanganaSurepassAdapter,
  SIKKIM: require('../../src/modules/land-verification/providers/sikkim-surepass.adapter').createSikkimSurepassAdapter,
  TRIPURA: require('../../src/modules/land-verification/providers/tripura-surepass.adapter').createTripuraSurepassAdapter,
};

const TR = 'উত্তর ত্রিপুরা/north tripura';
const PS = 'পানিসাগর/panisagar';

// [slug, level, filters, surepass list]; filters are the cURL bodies verbatim.
const META = [
  ['gujarat', 'districts', undefined, 'district-list'],
  ['gujarat', 'talukas', { district: 'sabarkantha' }, 'taluka-list'],
  ['gujarat', 'villages', { district: 'sabarkantha', taluka: 'prantij' }, 'village-list'],
  ['gujarat', 'blocks', { district: 'sabarkantha', taluka: 'prantij', village: 'kamalpur' }, 'block-list'],
  ['madhya-pradesh', 'districts', undefined, 'district-list'],
  ['madhya-pradesh', 'tehsils', { district: 'sehore' }, 'tehsil-list'],
  ['madhya-pradesh', 'villages', { district: 'sehore', tehsil: 'doraha' }, 'village-list'],
  ['madhya-pradesh', 'khasras', { district: 'datia', tehsil: 'seondha', village: 'badokhari' }, 'khasra-list'],
  ['uttarakhand', 'districts', undefined, 'district-list'],
  ['uttarakhand', 'tehsils', { district: 'almora' }, 'tehsil-list'],
  ['uttarakhand', 'villages', { district: 'almora', tehsil: 'syalde' }, 'village-list'],
  ['uttarakhand', 'years', { district: 'almora', tehsil: 'syalde', village: 'ataliya' }, 'year-list'],
  ['uttarakhand', 'khatas', { district: 'almora', tehsil: 'syalde', village: 'ataliya', year: '1411-1416' }, 'khata-list'],
  ['delhi', 'districts', undefined, 'district-list'],
  ['delhi', 'tehsils', { district: 'south_east' }, 'tehsil-list'],
  ['delhi', 'villages', { district: 'south_west', tehsil: 'najafgarh' }, 'village-list'],
  ['delhi', 'khata-numbers', { district: 'south_west', tehsil: 'najafgarh', village: 'bakargarh' }, 'khata-number-list'],
  ['andaman-and-nicobar', 'districts', undefined, 'district-list'],
  ['andaman-and-nicobar', 'tehsils', { district: 'south_andaman' }, 'tehsil-list'],
  ['andaman-and-nicobar', 'villages', { district: 'south_andaman', tehsil: 'sri_vijaya_puram' }, 'village-list'],
  ['andaman-and-nicobar', 'survey-numbers', { district: 'south_andaman', tehsil: 'sri_vijaya_puram', village: 'brich_gunj' }, 'survey-number-list'],
  ['goa', 'districts', undefined, 'district-list'],
  ['goa', 'talukas', { district: 'kushavati' }, 'taluka-list'],
  ['goa', 'villages', { district: 'kushavati', taluka: 'canacona' }, 'village-list'],
  ['goa', 'survey-numbers', { district: 'kushavati', taluka: 'canacona', village: 'agonda' }, 'survey-number-list'],
  ['goa', 'subdivision-numbers', { district: 'kushavati', taluka: 'canacona', village: 'agonda', survey_number: '28' }, 'subdivision-number-list'],
  ['chhattisgarh', 'districts', undefined, 'district-list'],
  ['chhattisgarh', 'tehsils', { district: 'कबीरधाम' }, 'tehsil-list'],
  ['chhattisgarh', 'villages', { district: 'कबीरधाम', tehsil: 'कुकदूर' }, 'village-list'],
  ['telangana', 'districts', undefined, 'district-list'],
  ['telangana', 'mandals', { district: 'adilabad' }, 'mandal-list'],
  ['telangana', 'villages', { district: 'adilabad', mandal: 'adilabad (rural)' }, 'village-list'],
  ['telangana', 'survey-numbers', { district: 'adilabad', mandal: 'adilabad (rural)', village: 'ankapoor' }, 'survey-number-list'],
  ['telangana', 'khata-numbers', { district: 'adilabad', mandal: 'adilabad (rural)', village: 'ankapoor', survey_number: '2/1' }, 'khata-number-list'],
  ['sikkim', 'districts', undefined, 'district-list'],
  ['sikkim', 'subdivisions', { district: 'gangtok district' }, 'subdivision-list'],
  ['sikkim', 'revenue-circles', { district: 'gangtok district', subdivision: 'gangtok sub-divison' }, 'revenue-circle-list'],
  [
    'sikkim',
    'revenue-blocks',
    { district: 'gangtok district', subdivision: 'gangtok sub-divison', revenue_circle: 'sichey revenue circle' },
    'revenue-block-list',
  ],
  ['tripura', 'districts', undefined, 'district-list'],
  ['tripura', 'subdivisions', { district: TR }, 'subdivision-list'],
  ['tripura', 'revenue-circles', { district: TR, subdivision: PS }, 'revenue-circle-list'],
  ['tripura', 'tehsils', { district: TR, subdivision: PS, revenue_circle: PS }, 'tehsil-list'],
  ['tripura', 'moujas', { district: TR, subdivision: PS, revenue_circle: PS, tehsil: PS }, 'mouja-list'],
];

// Verify payloads from the cURL documentation, keyed by slug.
const VERIFY = {
  gujarat: { district: 'sabarkantha', taluka: 'prantij', village: 'kamalpur', block: '14', owner_name: 'SHANUBHAI' },
  'madhya-pradesh': { district: 'datia', tehsil: 'seondha', village: 'badokhari', khasra: '48' },
  uttarakhand: { district: 'almora', tehsil: 'syalde', village: 'ataliya', year: '1411-1416', khata: '00001' },
  delhi: { district: 'south_west', tehsil: 'najafgarh', village: 'bakargarh', khata_no: '3' },
  'andaman-and-nicobar': { district: 'south_andaman', tehsil: 'sri_vijaya_puram', village: 'brich_gunj', survey_number: '1' },
  goa: { district: 'kushavati', taluka: 'canacona', village: 'agonda', survey_number: '28', subdivision_number: '1' },
  chhattisgarh: { district: 'कबीरधाम', tehsil: 'कुकदूर', village: 'अंजबाइनबांह (00014) - 5702052', khasra_number: '10' },
  telangana: { district: 'adilabad', mandal: 'adilabad (rural)', village: 'ankapoor', survey_number: '2/1', khata_number: '1' },
  sikkim: { district: 'gangtok district', subdivision: 'gangtok sub-divison', revenue_circle: 'sichey revenue circle', revenue_block: 'rongyek', plot_number: '123' },
  tripura: { district: TR, subdivision: PS, revenue_circle: PS, tehsil: PS, mouja: PS, khatian_number: '2885' },
};

const SLUGS = Object.keys(VERIFY);

const lastCall = (fetchImpl) => {
  const [url, init] = fetchImpl.mock.calls.at(-1);
  return { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, authorization: init.headers.authorization };
};

describe('metadata endpoints and payloads (exactly as documented)', () => {
  test.each(META)('%s %s', async (slug, level, filters, list) => {
    const fetchImpl = okFetch(['x', { name: 'y' }]);
    const options = await adapterWith(slug, fetchImpl).listOptions(level, filters || {});
    expect(options).toEqual([{ value: 'x', label: 'x' }, { value: 'y', label: 'y' }]);
    expect(lastCall(fetchImpl)).toEqual({
      url: `${BASE}/${slug}/meta/${list}`,
      method: filters ? 'POST' : 'GET',
      body: filters,
      authorization: 'Bearer surepass-test-token',
    });
  });

  test('every metadata level of the new states is covered above', () => {
    for (const slug of SLUGS) {
      const levels = Object.keys(registry.getAdapter(slug).metadataLevels);
      expect(META.filter(([s]) => s === slug).map(([, level]) => level)).toEqual(levels);
    }
  });
});

describe('verification endpoint and payload', () => {
  test.each(SLUGS)('%s', async (slug) => {
    const fetchImpl = okFetch({ client_id: 'c1', owner: 'x' });
    const adapter = adapterWith(slug, fetchImpl);
    const parsed = adapter.locatorSchema.safeParse(VERIFY[slug]);
    expect(parsed).toMatchObject({ success: true, data: VERIFY[slug] }); // values pass through unchanged
    const result = await adapter.fetchRecord(parsed.data);
    expect(result).toMatchObject({ record: { client_id: 'c1', owner: 'x' }, providerReference: 'c1' });
    const call = lastCall(fetchImpl);
    expect(call).toEqual({ url: `${BASE}/${slug}`, method: 'POST', body: VERIFY[slug], authorization: 'Bearer surepass-test-token' });
    expect(Object.keys(call.body)).toEqual(Object.keys(VERIFY[slug])); // documented field order
  });

  test('verification is billable: not retried on 5xx', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(502, { message: 'bad gateway' }));
    await expect(adapterWith('goa', fetchImpl).fetchRecord(VERIFY.goa)).rejects.toMatchObject({ statusCode: 503, code: 'SUREPASS_UNAVAILABLE' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('HTTP 200 + success:false is a provider rejection with its message', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { success: false, status_code: 422, message: 'Invalid khata', message_code: 'bad_khata' }));
    const error = await adapterWith('telangana', fetchImpl).fetchRecord(VERIFY.telangana).catch((e) => e);
    expect(error).toMatchObject({ statusCode: 422, code: 'SUREPASS_REJECTED_REQUEST', details: { providerMessage: 'Invalid khata' } });
  });

  test('metadata 429 is retried, 401 is not', async () => {
    const limited = jest.fn(async () => jsonResponse(429, { success: false }));
    await expect(adapterWith('sikkim', limited).listOptions('districts', {})).rejects.toMatchObject({ code: 'SUREPASS_RATE_LIMITED' });
    expect(limited).toHaveBeenCalledTimes(3);
    const denied = jest.fn(async () => jsonResponse(401, { success: false }));
    await expect(adapterWith('tripura', denied).listOptions('districts', {})).rejects.toMatchObject({ code: 'SUREPASS_AUTH_FAILED' });
    expect(denied).toHaveBeenCalledTimes(1);
  });
});

describe('validation', () => {
  const fieldsOf = (result) => result.error.issues.map((issue) => issue.path.join('.') || 'body');

  test.each(SLUGS)('%s: every locator field is required', (slug) => {
    const adapter = registry.getAdapter(slug);
    for (const name of Object.keys(VERIFY[slug])) {
      const { [name]: _omit, ...rest } = VERIFY[slug];
      expect(fieldsOf(adapter.locatorSchema.safeParse(rest))).toEqual([name]);
    }
  });

  test.each(SLUGS)('%s: unknown fields, blanks and markup are rejected', (slug) => {
    const adapter = registry.getAdapter(slug);
    const last = Object.keys(VERIFY[slug]).at(-1);
    expect(adapter.locatorSchema.safeParse({ ...VERIFY[slug], khasra_number_x: '1' }).success).toBe(false);
    expect(adapter.locatorSchema.safeParse({ ...VERIFY[slug], [last]: '   ' }).success).toBe(false);
    expect(adapter.locatorSchema.safeParse({ ...VERIFY[slug], district: '<script>' }).success).toBe(false);
    expect(adapter.locatorSchema.safeParse({ ...VERIFY[slug], [last]: 5 }).success).toBe(false);
  });

  test('a child list is never requested without its parents', async () => {
    cache.clear();
    const adapter = registry.getAdapter('goa');
    const spy = jest.spyOn(adapter, 'listOptions');
    const error = await metadataService
      .listOptions(adapter, 'subdivision-numbers', { district: 'kushavati', taluka: 'canacona', village: 'agonda' })
      .catch((e) => e);
    expect(error).toMatchObject({ statusCode: 422, code: 'VALIDATION_FAILED', details: [{ field: 'survey_number' }] });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('registry and parcel identity', () => {
  test('all 13 states are registered and the original three are unchanged', () => {
    const states = Object.fromEntries(registry.listStates().map((s) => [s.slug, s.fields.map((f) => f.name)]));
    expect(Object.keys(states)).toEqual(['punjab', 'maharashtra', 'bihar', ...SLUGS]);
    expect(states.punjab).toEqual(['district', 'tehsil', 'village', 'year', 'khasra_number']);
    expect(states.maharashtra).toEqual(['district', 'taluka', 'village', 'survey_part_number', 'survey_number']);
    expect(states.bihar).toEqual(['district', 'anchal', 'light', 'mouza', 'plot_number']);
    for (const slug of SLUGS) expect(states[slug]).toEqual(Object.keys(VERIFY[slug]));
  });

  test('user-entered fields are free text, the rest are dependent dropdowns', () => {
    const textFields = Object.fromEntries(registry.listStates().map((s) => [s.slug, s.fields.filter((f) => f.input === 'text').map((f) => f.name)]));
    expect(textFields).toMatchObject({
      gujarat: ['owner_name'],
      chhattisgarh: ['khasra_number'],
      sikkim: ['plot_number'],
      tripura: ['khatian_number'],
      goa: [],
      telangana: [],
    });
  });

  test.each([
    ['gujarat', 'GJ:sabarkantha:prantij:kamalpur:14:shanubhai'],
    ['uttarakhand', 'UK:almora:syalde:ataliya:1411-1416:00001'],
    ['telangana', 'TG:adilabad:adilabad (rural):ankapoor:2/1:1'],
    ['tripura', `TR:${TR}:${PS}:${PS}:${PS}:${PS}:2885`],
  ])('%s property id', (slug, expected) => {
    expect(registry.getAdapter(slug).propertyId(VERIFY[slug])).toBe(expected);
  });

  test('state codes are unique and identity is stable across case/whitespace', () => {
    const codes = registry.listStates().map((s) => s.stateCode);
    expect(new Set(codes).size).toBe(codes.length);
    const goa = registry.getAdapter('goa');
    expect(goa.propertyId({ ...VERIFY.goa, district: '  Kushavati ', survey_number: '2 8' })).toBe(goa.propertyId(VERIFY.goa));
    expect(registry.getAdapterByStateCode('ANDAMAN_AND_NICOBAR').slug).toBe('andaman-and-nicobar');
  });

  test('normalizeRecord unwraps the Surepass envelope', () => {
    const raw = { success: true, status_code: 200, data: { client_id: 'x', Owner_Name: '  राम  ', area: '1.50' } };
    expect(registry.getAdapter('madhya-pradesh').normalizeRecord(raw)).toEqual({ owner_name: 'राम', area: '1.5' });
  });
});
