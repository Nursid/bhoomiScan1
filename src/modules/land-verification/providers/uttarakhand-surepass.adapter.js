/**
 * Uttarakhand -> Surepass adapter (built by surepass-state-adapter.js).
 *
 * Hierarchy:  district -> tehsil -> village -> year -> khata
 *
 *   GET  /uttarakhand/meta/district-list
 *   POST /uttarakhand/meta/tehsil-list   { district }
 *   POST /uttarakhand/meta/village-list  { district, tehsil }
 *   POST /uttarakhand/meta/year-list     { district, tehsil, village }
 *   POST /uttarakhand/meta/khata-list    { district, tehsil, village, year }
 *   POST /uttarakhand                    { district, tehsil, village, year, khata }
 *
 * Years are fasli ranges such as "1411-1416" and are sent exactly as listed
 * (Punjab's "YYYY - YYYY" rewrite is not applied). Khata keeps leading zeros.
 */

const { placeName, parcelNumber } = require('./adapter-helpers');
const { createSurepassStateAdapter } = require('./surepass-state-adapter');

const spec = {
  stateCode: 'UTTARAKHAND',
  slug: 'uttarakhand',
  label: 'Uttarakhand',
  propertyPrefix: 'UK',
  levels: {
    districts: { list: 'district-list', filters: [] },
    tehsils: { list: 'tehsil-list', filters: ['district'] },
    villages: { list: 'village-list', filters: ['district', 'tehsil'] },
    years: { list: 'year-list', filters: ['district', 'tehsil', 'village'] },
    khatas: { list: 'khata-list', filters: ['district', 'tehsil', 'village', 'year'] },
  },
  schemas: {
    district: placeName('district'),
    tehsil: placeName('tehsil'),
    village: placeName('village'),
    year: parcelNumber('year'),
    khata: parcelNumber('khata'),
  },
  fields: [
    { name: 'district', label: 'District', input: 'select', source: 'districts' },
    { name: 'tehsil', label: 'Tehsil', input: 'select', source: 'tehsils' },
    { name: 'village', label: 'Village', input: 'select', source: 'villages' },
    { name: 'year', label: 'Year', input: 'select', source: 'years' },
    { name: 'khata', label: 'Khata Number', input: 'select', source: 'khatas' },
  ],
  parcelNumberFields: ['year', 'khata'],
  // Khatauni vocabulary.
  criticalFields: ['owner', 'khatedar', 'khata', 'khatauni', 'khasra', 'area', 'rakba', 'share', 'mutation', 'encumbrance', 'mortgage', 'remarks'],
  displayName: (l) => `Khata ${l.khata}, ${l.village}, ${l.tehsil}, ${l.district} (${l.year})`,
};

const createUttarakhandSurepassAdapter = (options) => createSurepassStateAdapter(spec, options);

module.exports = { createUttarakhandSurepassAdapter, spec };
