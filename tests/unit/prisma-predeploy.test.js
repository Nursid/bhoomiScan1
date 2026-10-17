jest.mock('child_process', () => ({ spawnSync: jest.fn() }));
jest.mock('fs', () => ({ statSync: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { checkPrismaPredeploy } = require('../../scripts/check-prisma-predeploy');

beforeEach(() => {
  jest.clearAllMocks();
  spawnSync.mockReturnValue({ status: 0 });
  fs.statSync.mockImplementation(() => ({ isFile: () => true, size: 100 }));
});

test('generates with the installed CLI before checking client files and both Linux engines', () => {
  expect(() => checkPrismaPredeploy()).not.toThrow();
  expect(spawnSync).toHaveBeenCalledWith(process.execPath, [
    require.resolve('prisma/build/index.js'), 'generate', '--schema',
    path.resolve(__dirname, '../../prisma/schema.prisma')
  ], { cwd: path.resolve(__dirname, '../..'), stdio: 'inherit' });
  expect(spawnSync.mock.invocationCallOrder[0]).toBeLessThan(fs.statSync.mock.invocationCallOrder[0]);
  expect(fs.statSync.mock.calls.map(([file]) => path.basename(file))).toEqual([
    'index.js', 'default.js', 'schema.prisma',
    'libquery_engine-debian-openssl-1.1.x.so.node',
    'libquery_engine-debian-openssl-3.0.x.so.node'
  ]);
});

test.each([{ status: 1 }, { status: null, error: new Error('cannot spawn') }])(
  'stops immediately when generation fails (%j)', (result) => {
    spawnSync.mockReturnValue(result);
    expect(checkPrismaPredeploy).toThrow('generation failed');
    expect(fs.statSync).not.toHaveBeenCalled();
  }
);

test.each(['libquery_engine-debian-openssl-1.1.x.so.node', 'libquery_engine-debian-openssl-3.0.x.so.node'])(
  'rejects missing engine %s', (name) => {
    fs.statSync.mockImplementation((file) => {
      if (path.basename(file) === name) throw new Error('ENOENT');
      return { isFile: () => true, size: 100 };
    });
    expect(checkPrismaPredeploy).toThrow(`Missing generated Prisma file: ${name}`);
  }
);

test.each([{ isFile: () => true, size: 0 }, { isFile: () => false, size: 100 }])(
  'rejects empty files and directories', (stat) => {
    fs.statSync.mockReturnValue(stat);
    expect(checkPrismaPredeploy).toThrow('Invalid generated Prisma file');
  }
);
