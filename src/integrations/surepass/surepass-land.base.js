/**
 * Shared plumbing for every Surepass land-verification state (Punjab, Maharashtra,
 * Bihar, ...). Each state provider extends this class and only declares its own
 * endpoint paths and payload field names; HTTP, auth, retries, error mapping,
 * logging and the audit trail all come from SurepassClient / utils/httpClient.
 *
 *   GET  /api/v1/land-verification/<state>/meta/<list>
 *   POST /api/v1/land-verification/<state>/meta/<list>   { ...state-specific filters }
 *   POST /api/v1/land-verification/<state>               { ...state-specific locator }
 */

const config = require('../../config');
const logger = require('../../utils/logger');
const { SurepassClient } = require('./surepass.client');

const LAND_BASE = '/api/v1/land-verification';

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

/**
 * Structure of a value without its contents (keys and types only), so an
 * unexpected provider response can be logged without leaking land-record data.
 */
const describeShape = (value, depth = 0) => {
  if (Array.isArray(value)) return depth >= 2 ? `array(${value.length})` : [`array(${value.length})`, value.length ? describeShape(value[0], depth + 1) : null];
  if (value && typeof value === 'object') {
    if (depth >= 2) return `object(${Object.keys(value).length} keys)`;
    return Object.fromEntries(Object.entries(value).slice(0, 25).map(([key, item]) => [key, describeShape(item, depth + 1)]));
  }
  return value === null ? 'null' : typeof value;
};

class SurepassStateLandProvider {
  /**
   * @param {object} options
   * @param {string} options.state   Surepass path segment, e.g. "punjab"
   * @param {SurepassClient} [options.client]
   */
  constructor({ state, client = new SurepassClient() }) {
    this.state = state;
    this.client = client;
    this.basePath = `${LAND_BASE}/${state}`;
  }

  metadataOptions(operation) {
    return { operation, retries: config.surepass.metadataRetries, retryOnTimeout: true, logFields: { state: this.state } };
  }

  /**
   * Calls /<state>/meta/<list>. GET when there is no payload (district lists), POST otherwise.
   * @returns {Promise<Array<{value: string, label: string}>>}
   */
  async listMetadata(list, payload, operation) {
    const path = `${this.basePath}/meta/${list}`;
    const options = this.metadataOptions(operation);
    const { body } = payload === undefined ? await this.client.get(path, options) : await this.client.post(path, payload, options);
    const items = toOptions(body?.data);
    const data = body?.data;
    const recognised = Array.isArray(data) || (data && typeof data === 'object' && Object.values(data).some(Array.isArray));
    if (!recognised) {
      logger.warn({ provider: 'SUREPASS', state: this.state, operation, shape: describeShape(body) }, 'unexpected surepass metadata response shape');
    }
    return items;
  }

  /**
   * Billable call. Not retried by default (SUREPASS_VERIFY_RETRIES=0) and never
   * retried after a timeout, since Surepass may have processed and charged it.
   * The full envelope is returned untouched (`body`) so it can be stored as-is.
   * @returns {{ body: object, record: object, providerReference: string|null, providerRequestId: string|null }}
   */
  async verifyLand(payload, operation) {
    const { body, headers, reference } = await this.client.post(this.basePath, payload, {
      operation,
      retries: config.surepass.verifyRetries,
      retryOnTimeout: false,
      logFields: { state: this.state },
    });
    if (!body?.data || typeof body.data !== 'object') {
      logger.warn({ provider: 'SUREPASS', state: this.state, operation, shape: describeShape(body) }, 'unexpected surepass verification response shape');
    }
    return {
      body,
      record: body?.data ?? {},
      providerReference: reference,
      providerRequestId: headers?.get?.('x-request-id') || headers?.get?.('x-amzn-requestid') || null,
    };
  }
}

module.exports = { SurepassStateLandProvider, toOptions, describeShape, LAND_BASE };
