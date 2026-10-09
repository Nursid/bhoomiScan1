/**
 * Surepass land-verification endpoints (Maharashtra). Maharashtra uses its own
 * hierarchy and terminology (taluka, survey part number, survey number); none of
 * Punjab's tehsil / year / khasra_number fields are sent.
 *
 *   GET  /api/v1/land-verification/maharashtra/meta/district-list
 *   POST /api/v1/land-verification/maharashtra/meta/taluka-list         { district }
 *   POST /api/v1/land-verification/maharashtra/meta/village-list        { district, taluka }
 *   POST /api/v1/land-verification/maharashtra/meta/survey-number-list  { district, taluka, village, survey_part_number }
 *   POST /api/v1/land-verification/maharashtra                          { district, taluka, village, survey_part_number, survey_number }
 *
 * Values are usually Devanagari (e.g. "पुणे") and are passed through unchanged.
 */

const { SurepassStateLandProvider } = require('./surepass-land.base');

class SurepassMaharashtraLandProvider extends SurepassStateLandProvider {
  constructor({ client } = {}) {
    super({ state: 'maharashtra', client });
  }

  async getDistricts() {
    return this.listMetadata('district-list', undefined, 'maharashtra.districts');
  }

  async getTalukas(district) {
    return this.listMetadata('taluka-list', { district }, 'maharashtra.talukas');
  }

  async getVillages(district, taluka) {
    return this.listMetadata('village-list', { district, taluka }, 'maharashtra.villages');
  }

  async getSurveyNumbers(district, taluka, village, surveyPartNumber) {
    return this.listMetadata(
      'survey-number-list',
      { district, taluka, village, survey_part_number: surveyPartNumber },
      'maharashtra.survey-numbers',
    );
  }

  /** Billable call (see SurepassStateLandProvider.verifyLand). */
  async verifyMaharashtraLand({ district, taluka, village, survey_part_number: surveyPartNumber, survey_number: surveyNumber }) {
    return this.verifyLand(
      { district, taluka, village, survey_part_number: surveyPartNumber, survey_number: surveyNumber },
      'maharashtra.verify',
    );
  }
}

module.exports = { SurepassMaharashtraLandProvider };
