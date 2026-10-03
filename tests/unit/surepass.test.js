const { SurepassClient } = require('../../src/integrations/surepass/surepass.client');
const { SurepassLandProvider, toOptions } = require('../../src/integrations/surepass/surepass-land.provider');

const jsonResponse = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const providerWith = (fetchImpl) => new SurepassLandProvider({ client: new SurepassClient({ fetchImpl }) });

const expectError = async (promise, status, code) => {
  await expect(promise).rejects.toMatchObject({ statusCode: status, code });
};

describe('SurepassClient / SurepassLandProvider', () => {
  test('sends bearer token to the configured base URL and returns options', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { success: true, status_code: 200, data: ['Amritsar', 'Ludhiana'] }));
    const options = await providerWith(fetchImpl).getDistricts();
    expect(options).toEqual([
      { value: 'Amritsar', label: 'Amritsar' },
      { value: 'Ludhiana', label: 'Ludhiana' },
    ]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://sandbox.surepass.test/api/v1/land-verification/punjab/meta/district-list');
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe('Bearer surepass-test-token');
  });

  test('posts the documented payloads', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { village_list: [{ name: 'Abu Said' }] } }));
    const provider = providerWith(fetchImpl);
    await provider.getKhasraNumbers('amritsar', 'ajnala', 'abu said', '2020 - 2021');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toMatch(/\/meta\/khasra-number-list$/);
    expect(JSON.parse(init.body)).toEqual({ district: 'amritsar', tehsil: 'ajnala', village: 'abu said', year: '2020 - 2021' });

    const verifyFetch = jest.fn().mockResolvedValue(jsonResponse(200, { success: true, data: { client_id: 'land_abc', owner: 'x' } }));
    const result = await providerWith(verifyFetch).verifyPunjabLand({
      district: 'amritsar',
      tehsil: 'ajnala',
      village: 'abu said',
      year: '2020 - 2021',
      khasra_number: '14//6/2---1',
    });
    expect(verifyFetch.mock.calls[0][0]).toBe('https://sandbox.surepass.test/api/v1/land-verification/punjab');
    expect(JSON.parse(verifyFetch.mock.calls[0][1].body).khasra_number).toBe('14//6/2---1');
    expect(result.providerReference).toBe('land_abc');
    expect(result.record).toEqual({ client_id: 'land_abc', owner: 'x' });
  });

  test('401 -> 503 SUREPASS_AUTH_FAILED (never retried)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(401, { success: false, message: 'Invalid token' }));
    await expectError(providerWith(fetchImpl).getDistricts(), 503, 'SUREPASS_AUTH_FAILED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('429 -> 429 with retryAfter, retried for metadata', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(429, { success: false, message: 'Too many' }, { 'retry-after': '0' }));
    const error = await providerWith(fetchImpl).getDistricts().catch((e) => e);
    expect(error).toMatchObject({ statusCode: 429, code: 'SUREPASS_RATE_LIMITED' });
    expect(fetchImpl).toHaveBeenCalledTimes(3); // 1 + SUREPASS_METADATA_RETRIES=2
  });

  test('5xx -> 503 and recovers on retry for metadata', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { message: 'down' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(jsonResponse(200, { success: true, data: ['Ajnala'] }));
    await expect(providerWith(fetchImpl).getTehsils('amritsar')).resolves.toEqual([{ value: 'Ajnala', label: 'Ajnala' }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('land verification is not retried on 5xx (billable call)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(500, { message: 'boom' }));
    await expectError(
      providerWith(fetchImpl).verifyPunjabLand({ district: 'a', tehsil: 'b', village: 'c', year: '2020 - 2021', khasra_number: '1' }),
      503,
      'SUREPASS_UNAVAILABLE',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('HTTP 200 with success:false is an error (422 -> SUREPASS_REJECTED_REQUEST)', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(200, { success: false, status_code: 422, message: 'Invalid year', message_code: 'bad_year' }));
    const error = await providerWith(fetchImpl).getYears('a', 'b', 'c').catch((e) => e);
    expect(error).toMatchObject({ statusCode: 422, code: 'SUREPASS_REJECTED_REQUEST' });
    expect(error.details).toEqual({ providerMessage: 'Invalid year', providerCode: 'bad_year' });
  });

  test('not found message -> 404 LAND_RECORD_NOT_FOUND', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(jsonResponse(422, { success: false, message: 'No record found' }));
    await expectError(
      providerWith(fetchImpl).verifyPunjabLand({ district: 'a', tehsil: 'b', village: 'c', year: '2020 - 2021', khasra_number: '1' }),
      404,
      'LAND_RECORD_NOT_FOUND',
    );
  });

  test('timeout -> 504 SUREPASS_TIMEOUT', async () => {
    const fetchImpl = jest.fn((url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    await expectError(
      providerWith(fetchImpl).verifyPunjabLand({ district: 'a', tehsil: 'b', village: 'c', year: '2020 - 2021', khasra_number: '1' }),
      504,
      'SUREPASS_TIMEOUT',
    );
  });

  test('network error -> 502 SUREPASS_UNREACHABLE', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expectError(
      providerWith(fetchImpl).verifyPunjabLand({ district: 'a', tehsil: 'b', village: 'c', year: '2020 - 2021', khasra_number: '1' }),
      502,
      'SUREPASS_UNREACHABLE',
    );
  });
});

describe('toOptions', () => {
  test('handles arrays, wrapped arrays, objects and blanks', () => {
    expect(toOptions(['a', ' ', null])).toEqual([{ value: 'a', label: 'a' }]);
    expect(toOptions({ list: [{ code: '01', name: 'Amritsar' }] })).toEqual([{ value: '01', label: 'Amritsar' }]);
    expect(toOptions(null)).toEqual([]);
  });
});
