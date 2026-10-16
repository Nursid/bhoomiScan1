const mockProcessDueDocuments = jest.fn();

jest.mock('../../src/config', () => ({ jobs: { smartContractRetryIntervalSeconds: 60, subscriptionExpiryIntervalSeconds: 60, recurringVerificationIntervalSeconds: 60 } }));
jest.mock('../../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../../src/jobs/recurring-verification.job', () => ({ run: jest.fn() }));
jest.mock('../../src/modules/smart-contract/smart-contract.service', () => ({ processDueRecords: jest.fn() }));
jest.mock('../../src/modules/documents/documents.service', () => ({ processDueDocuments: mockProcessDueDocuments }));
jest.mock('../../src/modules/subscriptions/subscriptions.service', () => ({ expireDueSubscriptions: jest.fn() }));

const { JOBS } = require('../../src/jobs/scheduler');

describe('uploaded document retry job', () => {
  test('runs due document transaction recovery on the existing retry interval', async () => {
    const job = JOBS.find(({ name }) => name === 'uploaded-document-retry');
    expect(job).toBeDefined();
    expect(job.everySeconds()).toBe(60);
    await job.run();
    expect(mockProcessDueDocuments).toHaveBeenCalledTimes(1);
  });
});
