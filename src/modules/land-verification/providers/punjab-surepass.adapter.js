/**
 * Punjab -> Surepass adapter.
 *
 * Every state adapter implements the same contract, which is all that
 * land-verification.service knows about providers:
 *
 *   stateCode, slug, provider, normalizerVersion
 *   metadataLevels                 { level: { filters: [...] } }  (order = drill-down)
 *   locatorSchema                  zod schema for the verify body
 *   listOptions(level, filters)    -> [{ value, label }]
 *   fetchRecord(locator)           -> { raw, record, providerReference, providerRequestId }
 *   normalizeRecord(raw)           -> canonical comparison form (input: stored raw response)
 *   diffOptions                    options for land-record-diff.service
 *   parcelIdentity(locator)        -> normalized locator used for the parcel key
 *   propertyId(locator)            -> stable id sent to the smart contract
 *   displayName(locator)
 *
 * Adding Haryana/UP = a new adapter file + one line in the registry.
 */

const { z } = require('zod');
const { SurepassLandProvider } = require('../../../integrations/surepass/surepass-land.provider');
const { normalizeRecord } = require('../land-record-normalizer');
const { resolveIgnoredFields } = require('../land-record-ignore');

const NORMALIZER_VERSION = 'surepass-punjab@1';

const text = (name, max = 120) =>
  z
    .string({ required_error: `${name} is required`, invalid_type_error: `${name} must be a string` })
    .trim()
    .min(1, `${name} is required`)
    .max(max, `${name} is too long`)
    // Letters (any script), digits, spaces and the punctuation real names use.
    .regex(/^[\p{L}\p{M}\p{N} .,'()&_-]+$/u, `${name} contains invalid characters`);

const year = z
  .string({ required_error: 'year is required' })
  .trim()
  .regex(/^\d{4}\s*-\s*\d{4}$/, 'year must look like "2020 - 2021"')
  .transform((value) => value.replace(/^(\d{4})\s*-\s*(\d{4})$/, '$1 - $2'));

const khasraNumber = z
  .string({ required_error: 'khasra_number is required' })
  .trim()
  .min(1, 'khasra_number is required')
  .max(60, 'khasra_number is too long')
  .regex(/^[A-Za-z0-9/\-\s.]+$/, 'khasra_number contains invalid characters');

const locatorSchema = z
  .object({
    district: text('district'),
    tehsil: text('tehsil'),
    village: text('village'),
    year,
    khasra_number: khasraNumber,
  })
  .strict();

const metadataLevels = {
  districts: { filters: [] },
  tehsils: { filters: ['district'] },
  villages: { filters: ['district', 'tehsil'] },
  years: { filters: ['district', 'tehsil', 'village'] },
  khasras: { filters: ['district', 'tehsil', 'village', 'year'] },
};

const filterSchemas = {
  district: text('district'),
  tehsil: text('tehsil'),
  village: text('village'),
  year,
};

// Field names seen in Punjab jamabandi data. Diff paths matching these are flagged critical.
const CRITICAL_FIELDS = [
  'owner',
  'malik',
  'cultivator',
  'kashtkar',
  'share',
  'hissa',
  'area',
  'rakba',
  'khewat',
  'khatauni',
  'khasra',
  'mortgage',
  'mutation',
  'intkal',
  'remarks',
  'kaifiyat',
  'encumbrance',
  'lease',
];

const diffOptions = {
  ignoredFields: resolveIgnoredFields([]),
  // Fill in once real Surepass Punjab payloads are observed, e.g.
  //   owner_details: ['owner_name', 'father_name']
  // Unkeyed arrays still compare correctly (order-insensitive ADD/REMOVE).
  arrayKeys: {},
  orderedArrays: [],
  criticalFields: CRITICAL_FIELDS,
};

const normalizeOptions = { ignoredFields: diffOptions.ignoredFields, orderedArrays: diffOptions.orderedArrays };

const createPunjabSurepassAdapter = ({ provider = new SurepassLandProvider() } = {}) => ({
  stateCode: 'PUNJAB',
  slug: 'punjab',
  provider: 'SUREPASS',
  normalizerVersion: NORMALIZER_VERSION,
  metadataLevels,
  filterSchemas,
  locatorSchema,
  diffOptions,

  async listOptions(level, filters) {
    switch (level) {
      case 'districts':
        return provider.getDistricts();
      case 'tehsils':
        return provider.getTehsils(filters.district);
      case 'villages':
        return provider.getVillages(filters.district, filters.tehsil);
      case 'years':
        return provider.getYears(filters.district, filters.tehsil, filters.village);
      case 'khasras':
        return provider.getKhasraNumbers(filters.district, filters.tehsil, filters.village, filters.year);
      default:
        throw new Error(`Unknown metadata level ${level}`);
    }
  },

  async fetchRecord(locator) {
    const result = await provider.verifyPunjabLand(locator);
    return { raw: result.body, record: result.record, providerReference: result.providerReference, providerRequestId: result.providerRequestId };
  },

  /** Input is the full stored Surepass envelope; only `data` describes the land. */
  normalizeRecord(raw) {
    const record = raw && typeof raw === 'object' && 'data' in raw ? raw.data : raw;
    return normalizeRecord(record, normalizeOptions);
  },

  parcelIdentity(locator) {
    const clean = (value) => String(value).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
    return {
      district: clean(locator.district),
      tehsil: clean(locator.tehsil),
      village: clean(locator.village),
      year: clean(locator.year).replace(/\s*-\s*/, '-'),
      khasra_number: clean(locator.khasra_number).replace(/\s+/g, ''),
    };
  },

  propertyId(locator) {
    const id = this.parcelIdentity(locator);
    return `PB:${id.district}:${id.tehsil}:${id.village}:${id.year}:${id.khasra_number}`;
  },

  displayName(locator) {
    return `Khasra ${locator.khasra_number}, ${locator.village}, ${locator.tehsil}, ${locator.district} (${locator.year})`;
  },
});

module.exports = { createPunjabSurepassAdapter, NORMALIZER_VERSION, CRITICAL_FIELDS };
