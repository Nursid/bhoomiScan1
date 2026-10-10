/**
 * Delhi -> Surepass adapter (built by surepass-state-adapter.js).
 *
 * Hierarchy:  district -> tehsil -> village -> khata_no
 *
 *   GET  /delhi/meta/district-list
 *   POST /delhi/meta/tehsil-list        { district }
 *   POST /delhi/meta/village-list       { district, tehsil }
 *   POST /delhi/meta/khata-number-list  { district, tehsil, village }
 *   POST /delhi                         { district, tehsil, village, khata_no }
 *
 * The verify path is assumed to follow the other states (/delhi); the shared
 * cURL omitted it. Districts use underscores, e.g. "south_west".
 */

const { placeName, parcelNumber } = require('./adapter-helpers');
const { createSurepassStateAdapter } = require('./surepass-state-adapter');

const spec = {
  stateCode: 'DELHI',
  slug: 'delhi',
  label: 'Delhi',
  propertyPrefix: 'DL',
  levels: {
    districts: { list: 'district-list', filters: [] },
    tehsils: { list: 'tehsil-list', filters: ['district'] },
    villages: { list: 'village-list', filters: ['district', 'tehsil'] },
    'khata-numbers': { list: 'khata-number-list', filters: ['district', 'tehsil', 'village'] },
  },
  schemas: {
    district: placeName('district'),
    tehsil: placeName('tehsil'),
    village: placeName('village'),
    khata_no: parcelNumber('khata_no'),
  },
  fields: [
    { name: 'district', label: 'District', input: 'select', source: 'districts' },
    { name: 'tehsil', label: 'Tehsil', input: 'select', source: 'tehsils' },
    { name: 'village', label: 'Village', input: 'select', source: 'villages' },
    { name: 'khata_no', label: 'Khata Number', input: 'select', source: 'khata-numbers' },
  ],
  parcelNumberFields: ['khata_no'],
  criticalFields: ['owner', 'khata', 'khatauni', 'khasra', 'area', 'share', 'mutation', 'encumbrance', 'mortgage', 'remarks'],
  displayName: (l) => `Khata ${l.khata_no}, ${l.village}, ${l.tehsil}, ${l.district}`,
};

const createDelhiSurepassAdapter = (options) => createSurepassStateAdapter(spec, options);

module.exports = { createDelhiSurepassAdapter, spec };
