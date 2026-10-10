/**
 * Chhattisgarh -> Surepass adapter (built by surepass-state-adapter.js).
 *
 * Hierarchy:  district -> tehsil -> village -> khasra_number
 *
 *   GET  /chhattisgarh/meta/district-list
 *   POST /chhattisgarh/meta/tehsil-list   { district }
 *   POST /chhattisgarh/meta/village-list  { district, tehsil }
 *   POST /chhattisgarh                    { district, tehsil, village, khasra_number }
 *
 * Values are Devanagari; villages carry codes, e.g. "अंजबाइनबांह (00014) - 5702052".
 * The request body of Surepass's khasra-number-list is undocumented, so
 * khasra_number is entered by the user rather than guessing that payload.
 */

const { placeName, parcelNumber } = require('./adapter-helpers');
const { createSurepassStateAdapter } = require('./surepass-state-adapter');

const spec = {
  stateCode: 'CHHATTISGARH',
  slug: 'chhattisgarh',
  label: 'Chhattisgarh',
  propertyPrefix: 'CG',
  levels: {
    districts: { list: 'district-list', filters: [] },
    tehsils: { list: 'tehsil-list', filters: ['district'] },
    villages: { list: 'village-list', filters: ['district', 'tehsil'] },
  },
  schemas: {
    district: placeName('district'),
    tehsil: placeName('tehsil'),
    village: placeName('village', 200),
    khasra_number: parcelNumber('khasra_number'),
  },
  fields: [
    { name: 'district', label: 'District', input: 'select', source: 'districts' },
    { name: 'tehsil', label: 'Tehsil', input: 'select', source: 'tehsils' },
    { name: 'village', label: 'Village', input: 'select', source: 'villages' },
    { name: 'khasra_number', label: 'Khasra Number', input: 'text' },
  ],
  parcelNumberFields: ['khasra_number'],
  // Bhuiyan khasra / B-1 vocabulary.
  criticalFields: ['owner', 'bhumiswami', 'khata', 'khasra', 'area', 'rakba', 'share', 'mutation', 'encumbrance', 'mortgage', 'remarks'],
  displayName: (l) => `Khasra ${l.khasra_number}, ${l.village}, ${l.tehsil}, ${l.district}`,
};

const createChhattisgarhSurepassAdapter = (options) => createSurepassStateAdapter(spec, options);

module.exports = { createChhattisgarhSurepassAdapter, spec };
