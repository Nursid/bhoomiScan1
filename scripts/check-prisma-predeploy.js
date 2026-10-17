const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
// Match the Linux binaryTargets in prisma/schema.prisma. Check both OpenSSL
// variants before AppSail packages build_path, including node_modules.
const requiredFiles = [
  'index.js',
  'default.js',
  'schema.prisma',
  'libquery_engine-debian-openssl-1.1.x.so.node',
  'libquery_engine-debian-openssl-3.0.x.so.node'
];

function checkPrismaPredeploy() {
  const result = spawnSync(process.execPath, [
    require.resolve('prisma/build/index.js'),
    'generate', '--schema', path.join(projectRoot, 'prisma', 'schema.prisma')
  ], { cwd: projectRoot, stdio: 'inherit' });

  if (result.error || result.status !== 0) {
    throw new Error('Prisma Client generation failed; packaging must stop.');
  }

  for (const name of requiredFiles) {
    let stat;
    try {
      stat = fs.statSync(path.join(projectRoot, 'node_modules', '.prisma', 'client', name));
    } catch {
      throw new Error(`Missing generated Prisma file: ${name}; packaging must stop.`);
    }
    if (!stat.isFile() || stat.size === 0) {
      throw new Error(`Invalid generated Prisma file: ${name}; packaging must stop.`);
    }
  }
}

if (require.main === module) {
  try {
    checkPrismaPredeploy();
    console.log('Prisma Client and both required Linux engines are ready for packaging.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { checkPrismaPredeploy };
