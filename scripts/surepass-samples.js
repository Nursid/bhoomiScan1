/**
 * One known-good locator per state, from the Surepass cURL documentation (and
 * the existing tests for punjab / maharashtra / bihar). Used by the live check
 * and as request examples in the generated OpenAPI file.
 */

const TR = 'উত্তর ত্রিপুরা/north tripura';
const PS = 'পানিসাগর/panisagar';

module.exports = {
  punjab: { district: 'amritsar', tehsil: 'ajnala', village: 'abu said', year: '2020 - 2021', khasra_number: '14//6/2---1' },
  maharashtra: { district: 'पुणे', taluka: 'आंबेगाव', village: 'अडिवरे', survey_part_number: '1', survey_number: '1' },
  bihar: { district: 'araria', anchal: 'araria', light: 'अररिया बस्ती', mouza: 'अररिया बस्ती - 214/1', plot_number: '1' },
  gujarat: { district: 'sabarkantha', taluka: 'prantij', village: 'kamalpur', block: '14', owner_name: 'SHANUBHAI' },
  'madhya-pradesh': { district: 'datia', tehsil: 'seondha', village: 'badokhari', khasra: '48' },
  uttarakhand: { district: 'almora', tehsil: 'syalde', village: 'ataliya', year: '1411-1416', khata: '00001' },
  delhi: { district: 'south_west', tehsil: 'najafgarh', village: 'bakargarh', khata_no: '3' },
  'andaman-and-nicobar': { district: 'south_andaman', tehsil: 'sri_vijaya_puram', village: 'brich_gunj', survey_number: '1' },
  goa: { district: 'kushavati', taluka: 'canacona', village: 'agonda', survey_number: '28', subdivision_number: '1' },
  chhattisgarh: { district: 'कबीरधाम', tehsil: 'कुकदूर', village: 'अंजबाइनबांह (00014) - 5702052', khasra_number: '10' },
  telangana: { district: 'adilabad', mandal: 'adilabad (rural)', village: 'ankapoor', survey_number: '2/1', khata_number: '1' },
  sikkim: { district: 'gangtok district', subdivision: 'gangtok sub-divison', revenue_circle: 'sichey revenue circle', revenue_block: 'rongyek', plot_number: '123' },
  tripura: { district: TR, subdivision: PS, revenue_circle: PS, tehsil: PS, mouja: PS, khatian_number: '2885' },
};
