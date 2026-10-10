/**
 * Andaman & Nicobar -> Surepass adapter (built by surepass-state-adapter.js).
 *
 * Hierarchy:  district -> tehsil -> village -> survey_number
 *
 *   GET  /andaman-and-nicobar/meta/district-list
 *   POST /andaman-and-nicobar/meta/tehsil-list         { district }
 *   POST /andaman-and-nicobar/meta/village-list        { district, tehsil }
 *   POST /andaman-and-nicobar/meta/survey-number-list  { district, tehsil, village }
 *   POST /andaman-and-nicobar                          { district, tehsil, village, survey_number }
 */

const { placeName, parcelNumber } = require('./adapter-helpers');
const { createSurepassStateAdapter } = require('./surepass-state-adapter');

const spec = {
  stateCode: 'ANDAMAN_AND_NICOBAR',
  slug: 'andaman-and-nicobar',
  label: 'Andaman & Nicobar',
  propertyPrefix: 'AN',
  levels: {
    districts: { list: 'district-list', filters: [] },
    tehsils: { list: 'tehsil-list', filters: ['district'] },
    villages: { list: 'village-list', filters: ['district', 'tehsil'] },
    'survey-numbers': { list: 'survey-number-list', filters: ['district', 'tehsil', 'village'] },
  },
  schemas: {
    district: placeName('district'),
    tehsil: placeName('tehsil'),
    village: placeName('village'),
    survey_number: parcelNumber('survey_number'),
  },
  fields: [
    { name: 'district', label: 'District', input: 'select', source: 'districts' },
    { name: 'tehsil', label: 'Tehsil', input: 'select', source: 'tehsils' },
    { name: 'village', label: 'Village', input: 'select', source: 'villages' },
    { name: 'survey_number', label: 'Survey Number', input: 'select', source: 'survey-numbers' },
  ],
  parcelNumberFields: ['survey_number'],
  criticalFields: ['owner', 'pattadar', 'patta', 'survey', 'area', 'share', 'mutation', 'encumbrance', 'mortgage', 'remarks'],
  displayName: (l) => `Survey ${l.survey_number}, ${l.village}, ${l.tehsil}, ${l.district}`,
};

const createAndamanAndNicobarSurepassAdapter = (options) => createSurepassStateAdapter(spec, options);

module.exports = { createAndamanAndNicobarSurepassAdapter, spec };
