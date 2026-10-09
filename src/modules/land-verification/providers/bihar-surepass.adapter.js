/**
 * Bihar -> Surepass adapter (adapter contract: punjab-surepass.adapter.js).
 *
 * Hierarchy:  district -> anchal -> light -> mouza -> plot_number
 *
 * "light" is Surepass's own field name and is kept verbatim everywhere (locator,
 * parcel key, payload); it is not reinterpreted as any other concept. Surepass
 * has no plot-number list, so plot_number is entered by the user.
 */

const { z } = require('zod');
const { SurepassBiharLandProvider } = require('../../../integrations/surepass/surepass-bihar-land.provider');
const { placeName, parcelNumber, cleanIdentity, buildDiffOptions, surepassRecordNormalizer } = require('./adapter-helpers');

const NORMALIZER_VERSION = 'surepass-bihar@1';

const filterSchemas = {
  district: placeName('district'),
  anchal: placeName('anchal'),
  light: placeName('light'),
  // Surepass mouza values carry a number suffix, e.g. "अररिया बस्ती - 214/1".
  mouza: placeName('mouza', 200),
};

const locatorSchema = z
  .object({
    ...filterSchemas,
    plot_number: parcelNumber('plot_number'),
  })
  .strict();

const metadataLevels = {
  districts: { filters: [] },
  anchals: { filters: ['district'] },
  lights: { filters: ['district', 'anchal'] },
  mouzas: { filters: ['district', 'anchal', 'light'] },
};

const fields = [
  { name: 'district', label: 'District', input: 'select', source: 'districts' },
  { name: 'anchal', label: 'Anchal', input: 'select', source: 'anchals' },
  { name: 'light', label: 'Light', input: 'select', source: 'lights' },
  { name: 'mouza', label: 'Mouza', input: 'select', source: 'mouzas' },
  { name: 'plot_number', label: 'Plot Number', input: 'text' },
];

// Bihar jamabandi / khatiyan vocabulary. Diff paths matching these are critical.
const CRITICAL_FIELDS = [
  'owner',
  'raiyat',
  'malik',
  'khata',
  'khesra',
  'plot',
  'area',
  'rakba',
  'share',
  'jamabandi',
  'mutation',
  'dakhil',
  'kharij',
  'boundary',
  'chauhaddi',
  'encumbrance',
  'mortgage',
  'lagan',
  'remarks',
];

const diffOptions = buildDiffOptions(CRITICAL_FIELDS);
const normalize = surepassRecordNormalizer(diffOptions);

const createBiharSurepassAdapter = ({ provider = new SurepassBiharLandProvider() } = {}) => ({
  stateCode: 'BIHAR',
  slug: 'bihar',
  label: 'Bihar',
  provider: 'SUREPASS',
  normalizerVersion: NORMALIZER_VERSION,
  metadataLevels,
  filterSchemas,
  fields,
  locatorSchema,
  diffOptions,

  async listOptions(level, filters) {
    switch (level) {
      case 'districts':
        return provider.getDistricts();
      case 'anchals':
        return provider.getAnchals(filters.district);
      case 'lights':
        return provider.getLights(filters.district, filters.anchal);
      case 'mouzas':
        return provider.getMouzas(filters.district, filters.anchal, filters.light);
      default:
        throw new Error(`Unknown metadata level ${level}`);
    }
  },

  async fetchRecord(locator) {
    const result = await provider.verifyBiharLand(locator);
    return { raw: result.body, record: result.record, providerReference: result.providerReference, providerRequestId: result.providerRequestId };
  },

  normalizeRecord(raw) {
    return normalize(raw);
  },

  parcelIdentity(locator) {
    return {
      district: cleanIdentity(locator.district),
      anchal: cleanIdentity(locator.anchal),
      light: cleanIdentity(locator.light),
      mouza: cleanIdentity(locator.mouza),
      plot_number: cleanIdentity(locator.plot_number).replace(/\s+/g, ''),
    };
  },

  propertyId(locator) {
    const id = this.parcelIdentity(locator);
    return `BR:${id.district}:${id.anchal}:${id.light}:${id.mouza}:${id.plot_number}`;
  },

  displayName(locator) {
    return `Plot ${locator.plot_number}, ${locator.mouza}, ${locator.light}, ${locator.anchal}, ${locator.district}`;
  },
});

module.exports = { createBiharSurepassAdapter, NORMALIZER_VERSION, CRITICAL_FIELDS };
