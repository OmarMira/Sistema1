'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { prepare, copy, copyPostgres, PUBLIC_FILES } = require('./payload.cjs');
const ROOT = path.resolve(__dirname, '../..');
const CACHE = path.join(__dirname, '.cache');
const NODE_HOME = path.join(CACHE, 'runtime/node-v24.22.2-win-x64');
const POSTGRES = path.join(CACHE, 'postgres16/verified/pgsql');
function discoverISCC() {
  for (const file of ['C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe', 'C:\\Program Files\\Inno Setup 6\\ISCC.exe']) if (fs.existsSync(file)) return file;
  return null;
}
function baseEnv(extra = {}) {
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'PATH']) if (process.env[name]) env[name] = process.env[name];
  return { ...env, NEXT_TELEMETRY_DISABLED: '1', ...extra };
}
function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { shell: false, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} exited ${result.status}`);
}
function supplementPackage(name, destination, seen = new Set()) {
  if (seen.has(name)) return; seen.add(name);
  const source = path.join(ROOT, 'node_modules', name);
  if (!fs.existsSync(path.join(source, 'package.json'))) return;
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  copy(source, path.join(destination, 'node_modules', name));
  for (const dependency of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) supplementPackage(dependency, destination, seen);
}
function build(resumeWork) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 is required');
  const node = path.join(NODE_HOME, 'node.exe');
  for (const f of [node, path.join(POSTGRES, 'bin/initdb.exe')]) if (!fs.existsSync(f)) throw new Error('Verified extracted runtime is missing: ' + path.basename(f));
  const archive = path.join(CACHE, 'runtime/node-v24.22.2-win-x64.zip');
  const expected = fs.readFileSync(path.join(CACHE, 'runtime/SHASUMS256.txt'), 'utf8').split(/\r?\n/).find(line => line.endsWith('  node-v24.22.2-win-x64.zip'));
  if (!expected || crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== expected.split(/\s+/)[0]) throw new Error('Official Node checksum mismatch');
  fs.mkdirSync(path.join(__dirname, '.checks'), { recursive: true });
  const work = resumeWork ? fs.realpathSync.native(path.resolve(resumeWork)) : fs.mkdtempSync(path.join(__dirname, '.checks/build-'));
  if (resumeWork) {
    const relativeWork = path.relative(fs.realpathSync.native(path.join(__dirname, '.checks')), work);
    if (relativeWork.startsWith('..') || path.isAbsolute(relativeWork) || !/^build-[^\\/]+$/.test(relativeWork) || !/^[0-9a-f-]{36}$/.test(fs.readFileSync(path.join(work, '.owned-build'), 'utf8'))) throw new Error('Not an owned build workspace');
  } else fs.writeFileSync(path.join(work, '.owned-build'), crypto.randomUUID(), { flag: 'wx' });
  const source = path.join(work, 'source'); if (!resumeWork) fs.mkdirSync(source);
  copy(path.join(ROOT, 'src'), path.join(source, 'src'));
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'postcss.config.mjs', 'tailwind.config.ts', 'components.json', 'next-env.d.ts']) copy(path.join(ROOT, name), path.join(source, name));
  copy(path.join(ROOT, 'rules'), path.join(source, 'rules'));
  for (const name of PUBLIC_FILES) copy(path.join(ROOT, 'public', name), path.join(source, 'public', name));
  copy(path.join(ROOT, 'prisma/schema.prisma'), path.join(source, 'prisma/schema.prisma'));
  copy(path.join(ROOT, 'prisma/migrations'), path.join(source, 'prisma/migrations'));
  if (!fs.existsSync(path.join(source, 'node_modules'))) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(source, 'node_modules'), 'junction');
  // Build-only config: no change to the running development server or its .next.
  fs.writeFileSync(path.join(source, 'next.config.js'), `module.exports = { output: 'standalone', outputFileTracingRoot: ${JSON.stringify(ROOT)}, typescript: {ignoreBuildErrors:false}, reactStrictMode:true };\n`);
  const env = baseEnv({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://isolated:isolated@127.0.0.1:1/isolated?connect_timeout=1', SESSION_SECRET: crypto.randomBytes(32).toString('hex'), HMAC_SECRET: crypto.randomBytes(32).toString('hex') });
  console.log('ISOLATED_BUILD_SOURCE=' + source);
  run(node, [path.join(ROOT, 'node_modules/next/dist/bin/next'), 'build', '--webpack'], { cwd: source, env });
  const payload = path.join(work, 'payload');
  const relative = path.relative(ROOT, source);
  const nested = fs.existsSync(path.join(source, '.next/standalone', relative, 'server.js')) ? relative : '';
  prepare(source, payload, nested);
  const seenPackages = new Set();
  const dependencies = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies;
  for (const name of Object.keys(dependencies)) supplementPackage(name, payload, seenPackages);
  for (const name of ['.prisma/client', '@napi-rs', '@img']) copy(path.join(ROOT, 'node_modules', name), path.join(payload, 'node_modules', name));
  copy(NODE_HOME, path.join(payload, 'runtime/node'));
  copyPostgres(POSTGRES, path.join(payload, 'runtime/postgres'));
  for (const name of ['launcher.cjs', 'runtime.cjs', 'preflight.cjs', 'start.cmd', 'stop.cmd']) copy(path.join(__dirname, name), path.join(payload, name));
  fs.writeFileSync(path.join(payload, 'payload.json'), JSON.stringify({ version: '0.2.0', node: '24.22.2', postgres: '16.15', createdAt: new Date().toISOString() }));
  fs.writeFileSync(path.join(__dirname, '.checks/latest-build.json'), JSON.stringify({ work, source, payload }, null, 2));
  console.log('PAYLOAD_READY=' + payload);
}
function compile(payload) {
  const compiler = discoverISCC(); if (!compiler) throw new Error('Inno Setup compiler not found');
  payload = path.resolve(payload);
  for (const name of ['server.js', 'runtime/node/node.exe', 'runtime/postgres/bin/postgres.exe', 'payload.json']) if (!fs.existsSync(path.join(payload, name))) throw new Error('Incomplete payload: ' + name);
  let size = 0; const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, e.name); if (e.isSymbolicLink()) throw new Error('Payload must not contain links'); if (e.isDirectory()) walk(file); else size += fs.statSync(file).size; } }; walk(payload);
  const compilerWork = fs.mkdtempSync(path.join(__dirname, '.checks/compiler-'));
  console.log('COMPILER_WORKSPACE=' + compilerWork);
  run(compiler, ['/Qp', '/DPayloadDir=' + payload, '/DProgramBytes=' + String(size * 2), path.join(__dirname, 'setup.iss')], { env: baseEnv({ TEMP: compilerWork, TMP: compilerWork }) });
  const exe = path.join(__dirname, '.checks/output/AccountExpress-Setup.exe');
  if (!fs.existsSync(exe)) throw new Error('Compiler did not produce the installer');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  fs.writeFileSync(exe + '.sha256', hash + '  AccountExpress-Setup.exe\n');
  console.log('INSTALLER_READY=' + exe + '\nSHA256=' + hash);
}
function main(args) {
  try {
    if (!args.length || args.length === 1 && args[0] === '--help') { console.log('AccountExpress Windows packaging\n  node build.cjs --build              Build production in a new isolated project workspace\n  node build.cjs --compile <payload>  Compile a verified payload using Inno Setup\n  node build.cjs --status             Report runtime/compiler availability (not build success)\nNo ambient .env, development database, .next or customer files are used.'); return; }
    if (args.length === 1 && args[0] === '--build') { build(); return; }
    if (args.length === 2 && args[0] === '--compile') { compile(args[1]); return; }
    if (args.length === 1 && args[0] === '--status') { console.log(JSON.stringify({ platform: process.platform, compiler: discoverISCC(), nodeAvailable: fs.existsSync(path.join(NODE_HOME, 'node.exe')), postgresAvailable: fs.existsSync(path.join(POSTGRES, 'bin/postgres.exe')) })); return; }
    console.error('Invalid options; use --help.'); process.exitCode = 2;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { discoverISCC, baseEnv, build, compile };
if (require.main === module) main(process.argv.slice(2));
