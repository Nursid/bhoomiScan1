/**
 * Goa -> Surepass adapter (built by surepass-state-adapter.js).
 *
 * Hierarchy:  district -> taluka -> village -> survey_number -> subdivision_number
 *
 *   GET  /goa/meta/district-list
 *   POST /goa/meta/taluka-list               { district }
 *   POST /goa/meta/village-list              { district, taluka }
 *   POST /goa/meta/survey-number-list        { district, taluka, village }
 *   POST /goa/meta/subdivision-number-list   { district, taluka, village, survey_number }
 *   POST /goa                                { district, taluka, village, survey_number, subdivision_number }
 */

const { placeName, parcelNumber } = require('./adapter-helpers');
const { createSurepassStateAdapter } = require('./surepass-state-adapter');

const spec = {
  stateCode: 'GOA',
  slug: 'goa',
  label: 'Goa',
  propertyPrefix: 'GA',
  levels: {
    districts: { list: 'district-list', filters: [] },
    talukas: { list: 'taluka-list', filters: ['district'] },
    villages: { list: 'village-list', filters: ['district', 'taluka'] },
    'survey-numbers': { list: 'survey-number-list', filters: ['district', 'taluka', 'village'] },
    'subdivision-numbers': { list: 'subdivision-number-list', filters: ['district', 'taluka', 'village', 'survey_number'] },
  },
  schemas: {
    district: placeName('district'),
    taluka: placeName('taluka'),
    village: placeName('village'),
    survey_number: parcelNumber('survey_number'),
    subdivision_number: parcelNumber('subdivision_number'),
  },
  fields: [
    { name: 'district', label: 'District', input: 'select', source: 'districts' },
    { name: 'taluka', label: 'Taluka', input: 'select', source: 'talukas' },
    { name: 'village', label: 'Village', input: 'select', source: 'villages' },
    { name: 'survey_number', label: 'Survey Number', input: 'select', source: 'survey-numbers' },
    { name: 'subdivision_number', label: 'Subdivision Number', input: 'select', source: 'subdivision-numbers' },
  ],
  parcelNumberFields: ['survey_number', 'subdivision_number'],
  // Form I & XIV vocabulary.
  criticalFields: ['owner', 'occupant', 'tenant', 'survey', 'subdivision', 'area', 'share', 'mutation', 'encumbrance', 'mortgage', 'other_rights', 'remarks'],
  displayName: (l) => `Survey ${l.survey_number}/${l.subdivision_number}, ${l.village}, ${l.taluka}, ${l.district}`,
};

const createGoaSurepassAdapter = (options) => createSurepassStateAdapter(spec, options);

module.exports = { createGoaSurepassAdapter, spec };
