'use strict';
const fs = require('node:fs');
const path = require('node:path');
const PUBLIC_FILES = ['favicon.ico', 'favicon.svg', 'hero-dashboard.png', 'logo.svg', 'robots.txt'];
function safeFile(file) {
  const parts = file.split(/[\\/]/);
  return !parts.some(part => /^\.env(?:\.|$)/i.test(part) || ['.git', '.data', '.cache', '.checks', '.operator', '.credentials', 'backups', 'test.db'].includes(part)) && !/(?:^|[\\/])public[\\/]uploads(?:[\\/]|$)/i.test(file);
}
function copy(source, destination, skipModules = false) {
  if (!fs.existsSync(source)) return;
  const base = path.resolve(source);
  fs.cpSync(source, destination, { recursive: true, dereference: true, filter: file => {
    const relative = path.relative(base, file);
    return safeFile(relative) && !(skipModules && relative.split(/[\\/]/).includes('node_modules'));
  } });
}
function copyPostgres(source, destination) {
  // The EDB archive also contains pgAdmin/Python and StackBuilder, not app prerequisites.
  const names = ['bin', 'lib', 'share', 'server_license.txt', 'commandlinetools_3rd_party_licenses.txt'];
  for (const name of names) if (!fs.existsSync(path.join(source, name))) throw new Error('PostgreSQL runtime or license is missing: ' + name);
  for (const name of names) copy(path.join(source, name), path.join(destination, name));
}
function prepare(source, destination, standaloneRelative = '') {
  source = path.resolve(source); destination = path.resolve(destination);
  if (fs.existsSync(destination)) throw new Error('Payload destination already exists');
  const standalone = path.join(source, '.next', 'standalone');
  const app = path.join(standalone, standaloneRelative);
  if (!fs.existsSync(path.join(app, 'server.js'))) throw new Error('Production standalone server.js is missing');
  fs.mkdirSync(destination, { recursive: false });
  // Next Windows junctions may point at the full development node_modules tree.
  // Production dependencies are copied explicitly by build.cjs, never via that junction.
  copy(app, destination, true);
  copy(path.join(source, '.next', 'static'), path.join(destination, '.next', 'static'));
  for (const name of PUBLIC_FILES) copy(path.join(source, 'public', name), path.join(destination, 'public', name));
  copy(path.join(source, 'rules'), path.join(destination, 'rules'));
  copy(path.join(source, 'prisma', 'migrations'), path.join(destination, 'prisma', 'migrations'));
  copy(path.join(source, 'prisma', 'schema.prisma'), path.join(destination, 'prisma', 'schema.prisma'));
  return destination;
}
function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log('node payload.cjs --source <isolated-build-source> --destination <new-directory>\nCopies standalone production files, static assets and immutable rules; excludes credentials and customer uploads.'); return;
  }
  if (args.length !== 4 || args[0] !== '--source' || args[2] !== '--destination') { console.error('Invalid options; use --help.'); process.exitCode = 2; return; }
  try { console.log(JSON.stringify({ ok: true, destination: prepare(args[1], args[3]) })); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare, copy, copyPostgres, safeFile, PUBLIC_FILES };
if (require.main === module) main(process.argv.slice(2));
