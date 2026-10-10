/**
 * Telangana -> Surepass adapter (built by surepass-state-adapter.js).
 *
 * Hierarchy:  district -> mandal -> village -> survey_number -> khata_number
 *
 *   GET  /telangana/meta/district-list
 *   POST /telangana/meta/mandal-list          { district }
 *   POST /telangana/meta/village-list         { district, mandal }
 *   POST /telangana/meta/survey-number-list   { district, mandal, village }
 *   POST /telangana/meta/khata-number-list    { district, mandal, village, survey_number }
 *   POST /telangana                           { district, mandal, village, survey_number, khata_number }
 */

const { placeName, parcelNumber } = require('./adapter-helpers');
const { createSurepassStateAdapter } = require('./surepass-state-adapter');

const spec = {
  stateCode: 'TELANGANA',
  slug: 'telangana',
  label: 'Telangana',
  propertyPrefix: 'TG',
  levels: {
    districts: { list: 'district-list', filters: [] },
    mandals: { list: 'mandal-list', filters: ['district'] },
    villages: { list: 'village-list', filters: ['district', 'mandal'] },
    'survey-numbers': { list: 'survey-number-list', filters: ['district', 'mandal', 'village'] },
    'khata-numbers': { list: 'khata-number-list', filters: ['district', 'mandal', 'village', 'survey_number'] },
  },
  schemas: {
    district: placeName('district'),
    mandal: placeName('mandal'),
    village: placeName('village'),
    survey_number: parcelNumber('survey_number'),
    khata_number: parcelNumber('khata_number'),
  },
  fields: [
    { name: 'district', label: 'District', input: 'select', source: 'districts' },
    { name: 'mandal', label: 'Mandal', input: 'select', source: 'mandals' },
    { name: 'village', label: 'Village', input: 'select', source: 'villages' },
    { name: 'survey_number', label: 'Survey Number', input: 'select', source: 'survey-numbers' },
    { name: 'khata_number', label: 'Khata Number', input: 'select', source: 'khata-numbers' },
  ],
  parcelNumberFields: ['survey_number', 'khata_number'],
  // Dharani / pahani vocabulary.
  criticalFields: ['owner', 'pattadar', 'patta', 'khata', 'survey', 'area', 'extent', 'share', 'mutation', 'encumbrance', 'mortgage', 'prohibited', 'remarks'],
  displayName: (l) => `Survey ${l.survey_number}, Khata ${l.khata_number}, ${l.village}, ${l.mandal}, ${l.district}`,
};

const createTelanganaSurepassAdapter = (options) => createSurepassStateAdapter(spec, options);

module.exports = { createTelanganaSurepassAdapter, spec };
