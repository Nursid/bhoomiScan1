/**
 * Maharashtra -> Surepass adapter (adapter contract: punjab-surepass.adapter.js).
 *
 * Hierarchy:  district -> taluka -> village -> survey_part_number -> survey_number
 *
 * Maharashtra keeps its own terminology end to end: the locator, the parcel key,
 * the smart-contract property id and the Surepass payload all use taluka /
 * survey_part_number / survey_number. Nothing is mapped onto Punjab's tehsil,
 * year or khasra_number.
 *
 * Surepass has no survey-part-number list, so survey_part_number is entered by
 * the user; it is required before the survey-number list can be requested.
 */

const { z } = require('zod');
const { SurepassMaharashtraLandProvider } = require('../../../integrations/surepass/surepass-maharashtra-land.provider');
const { placeName, parcelNumber, cleanIdentity, buildDiffOptions, surepassRecordNormalizer } = require('./adapter-helpers');

const NORMALIZER_VERSION = 'surepass-maharashtra@1';

const filterSchemas = {
  district: placeName('district'),
  taluka: placeName('taluka'),
  village: placeName('village'),
  survey_part_number: parcelNumber('survey_part_number'),
};

const locatorSchema = z
  .object({
    ...filterSchemas,
    survey_number: parcelNumber('survey_number'),
  })
  .strict();

const metadataLevels = {
  districts: { filters: [] },
  talukas: { filters: ['district'] },
  villages: { filters: ['district', 'taluka'] },
  'survey-numbers': { filters: ['district', 'taluka', 'village', 'survey_part_number'] },
};

const fields = [
  { name: 'district', label: 'District', input: 'select', source: 'districts' },
  { name: 'taluka', label: 'Taluka', input: 'select', source: 'talukas' },
  { name: 'village', label: 'Village', input: 'select', source: 'villages' },
  { name: 'survey_part_number', label: 'Survey Part Number', input: 'text' },
  { name: 'survey_number', label: 'Survey Number', input: 'select', source: 'survey-numbers' },
];

// 7/12 (satbara) extract vocabulary, English and transliterated. Diff paths matching these are critical.
const CRITICAL_FIELDS = [
  'owner',
  'occupant',
  'bhogvat',
  'khata',
  'area',
  'kshetra',
  'survey',
  'share',
  'tenant',
  'mutation',
  'ferfar',
  'encumbrance',
  'boja',
  'other_rights',
  'itar_hakk',
  'loan',
  'mortgage',
  'remarks',
];

const diffOptions = buildDiffOptions(CRITICAL_FIELDS);
const normalize = surepassRecordNormalizer(diffOptions);

const createMaharashtraSurepassAdapter = ({ provider = new SurepassMaharashtraLandProvider() } = {}) => ({
  stateCode: 'MAHARASHTRA',
  slug: 'maharashtra',
  label: 'Maharashtra',
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
      case 'talukas':
        return provider.getTalukas(filters.district);
      case 'villages':
        return provider.getVillages(filters.district, filters.taluka);
      case 'survey-numbers':
        return provider.getSurveyNumbers(filters.district, filters.taluka, filters.village, filters.survey_part_number);
      default:
        throw new Error(`Unknown metadata level ${level}`);
    }
  },

  async fetchRecord(locator) {
    const result = await provider.verifyMaharashtraLand(locator);
    return { raw: result.body, record: result.record, providerReference: result.providerReference, providerRequestId: result.providerRequestId };
  },

  normalizeRecord(raw) {
    return normalize(raw);
  },

  parcelIdentity(locator) {
    return {
      district: cleanIdentity(locator.district),
      taluka: cleanIdentity(locator.taluka),
      village: cleanIdentity(locator.village),
      survey_part_number: cleanIdentity(locator.survey_part_number).replace(/\s+/g, ''),
      survey_number: cleanIdentity(locator.survey_number).replace(/\s+/g, ''),
    };
  },

  propertyId(locator) {
    const id = this.parcelIdentity(locator);
    return `MH:${id.district}:${id.taluka}:${id.village}:${id.survey_part_number}:${id.survey_number}`;
  },

  displayName(locator) {
    return `Survey ${locator.survey_number} (part ${locator.survey_part_number}), ${locator.village}, ${locator.taluka}, ${locator.district}`;
  },
});

module.exports = { createMaharashtraSurepassAdapter, NORMALIZER_VERSION, CRITICAL_FIELDS };
