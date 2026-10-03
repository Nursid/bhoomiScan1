/**
 * Surepass land-verification endpoints (Punjab). Pure integration: knows Surepass
 * paths and payload names, nothing about subscriptions, storage or diffing.
 *
 *   GET  /api/v1/land-verification/punjab/meta/district-list
 *   POST /api/v1/land-verification/punjab/meta/tehsil-list        { district }
 *   POST /api/v1/land-verification/punjab/meta/village-list       { district, tehsil }
 *   POST /api/v1/land-verification/punjab/meta/year-list          { district, tehsil, village }
 *   POST /api/v1/land-verification/punjab/meta/khasra-number-list { district, tehsil, village, year }
 *   POST /api/v1/land-verification/punjab                         { district, tehsil, village, year, khasra_number }
 */

const config = require('../../config');
const { SurepassClient } = require('./surepass.client');

const BASE = '/api/v1/land-verification/punjab';

/**
 * Metadata lists come back as an array, or as an object holding one array
 * (e.g. { district_list: [...] }); items are strings or { name/value/code } objects.
 * Returns [{ value, label }].
 */
const toOptions = (data) => {
  let list = data;
  if (!Array.isArray(list) && list && typeof list === 'object') {
    list = Object.values(list).find(Array.isArray) || [];
  }
  if (!Array.isArray(list)) {
    return [];
  }
  return list
    .map((item) => {
      if (item === null || item === undefined) return null;
      if (typeof item !== 'object') {
        const text = String(item).trim();
        return text ? { value: text, label: text } : null;
      }
      const value = item.value ?? item.code ?? item.id ?? item.name ?? item.label;
      if (value === undefined || value === null || String(value).trim() === '') return null;
      return { value: String(value).trim(), label: String(item.name ?? item.label ?? value).trim() };
    })
    .filter(Boolean);
};

class SurepassLandProvider {
  constructor({ client = new SurepassClient() } = {}) {
    this.client = client;
  }

  metadataOptions(operation) {
    return { operation, retries: config.surepass.metadataRetries, retryOnTimeout: true };
  }

  async getDistricts() {
    const { body } = await this.client.get(`${BASE}/meta/district-list`, this.metadataOptions('punjab.districts'));
    return toOptions(body?.data);
  }

  async getTehsils(district) {
    const { body } = await this.client.post(`${BASE}/meta/tehsil-list`, { district }, this.metadataOptions('punjab.tehsils'));
    return toOptions(body?.data);
  }

  async getVillages(district, tehsil) {
    const { body } = await this.client.post(`${BASE}/meta/village-list`, { district, tehsil }, this.metadataOptions('punjab.villages'));
    return toOptions(body?.data);
  }

  async getYears(district, tehsil, village) {
    const { body } = await this.client.post(`${BASE}/meta/year-list`, { district, tehsil, village }, this.metadataOptions('punjab.years'));
    return toOptions(body?.data);
  }

  async getKhasraNumbers(district, tehsil, village, year) {
    const { body } = await this.client.post(
      `${BASE}/meta/khasra-number-list`,
      { district, tehsil, village, year },
      this.metadataOptions('punjab.khasras'),
    );
    return toOptions(body?.data);
  }

  /**
   * Billable call. Not retried by default (SUREPASS_VERIFY_RETRIES=0) and never
   * retried after a timeout, since Surepass may have processed and charged it.
   * @returns {{ body: object, record: object, providerReference: string|null, providerRequestId: string|null }}
   */
  async verifyPunjabLand({ district, tehsil, village, year, khasra_number: khasraNumber }) {
    const { body, headers, reference } = await this.client.post(
      BASE,
      { district, tehsil, village, year, khasra_number: khasraNumber },
      { operation: 'punjab.verify', retries: config.surepass.verifyRetries, retryOnTimeout: false },
    );
    return {
      body,
      record: body?.data ?? {},
      providerReference: reference,
      providerRequestId: headers?.get?.('x-request-id') || headers?.get?.('x-amzn-requestid') || null,
    };
  }
}

module.exports = { SurepassLandProvider, toOptions };
