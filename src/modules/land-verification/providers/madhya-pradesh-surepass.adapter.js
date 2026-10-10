/**
 * Madhya Pradesh -> Surepass adapter (built by surepass-state-adapter.js).
 *
 * Hierarchy:  district -> tehsil -> village -> khasra
 *
 *   GET  /madhya-pradesh/meta/district-list
 *   POST /madhya-pradesh/meta/tehsil-list   { district }
 *   POST /madhya-pradesh/meta/village-list  { district, tehsil }
 *   POST /madhya-pradesh/meta/khasra-list   { district, tehsil, village }
 *   POST /madhya-pradesh                    { district, tehsil, village, khasra }
 *
 * The verify field is "khasra" (not khasra_number). Surepass also offers
 * plot-number-list and owner-name-list for MP; they are not part of the verify
 * payload and are not exposed.
 */

const { placeName, parcelNumber } = require('./adapter-helpers');
const { createSurepassStateAdapter } = require('./surepass-state-adapter');

const spec = {
  stateCode: 'MADHYA_PRADESH',
  slug: 'madhya-pradesh',
  label: 'Madhya Pradesh',
  propertyPrefix: 'MP',
  levels: {
    districts: { list: 'district-list', filters: [] },
    tehsils: { list: 'tehsil-list', filters: ['district'] },
    villages: { list: 'village-list', filters: ['district', 'tehsil'] },
    khasras: { list: 'khasra-list', filters: ['district', 'tehsil', 'village'] },
  },
  schemas: {
    district: placeName('district'),
    tehsil: placeName('tehsil'),
    village: placeName('village'),
    khasra: parcelNumber('khasra'),
  },
  fields: [
    { name: 'district', label: 'District', input: 'select', source: 'districts' },
    { name: 'tehsil', label: 'Tehsil', input: 'select', source: 'tehsils' },
    { name: 'village', label: 'Village', input: 'select', source: 'villages' },
    { name: 'khasra', label: 'Khasra Number', input: 'select', source: 'khasras' },
  ],
  parcelNumberFields: ['khasra'],
  // Bhulekh khasra / B-1 vocabulary.
  criticalFields: ['owner', 'bhumiswami', 'khata', 'khasra', 'area', 'rakba', 'share', 'mutation', 'namantaran', 'encumbrance', 'mortgage', 'bandhak', 'remarks'],
  displayName: (l) => `Khasra ${l.khasra}, ${l.village}, ${l.tehsil}, ${l.district}`,
};

const createMadhyaPradeshSurepassAdapter = (options) => createSurepassStateAdapter(spec, options);

module.exports = { createMadhyaPradeshSurepassAdapter, spec };
