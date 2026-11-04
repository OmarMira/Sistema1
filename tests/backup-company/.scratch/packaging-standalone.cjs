// Ephemeral packaging proof; no committed test reads Git history.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const ts = require('typescript'), assert = require('node:assert/strict');
const repo = process.cwd();
const approved = 'C:/Users/PC Omar/AppData/Local/Temp/gp3WLD2T/sistema1-recovery-checks';
const root = fs.mkdtempSync(path.join(approved, 'package-slice1-'));
const selected = new Set(['src/lib/db.ts','src/lib/backup.ts','src/lib/backup-format.ts','src/lib/backup-storage.ts','tests/backup-company/helpers.ts','tests/backup-company/export.test.ts','docs/company-backup-format.md']);
const readHead = file => execFileSync('git', ['show', `HEAD:${file}`], { cwd: repo, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
const options = ts.parseJsonConfigFileContent(JSON.parse(readHead('tsconfig.json')), ts.sys, repo).options;
const queue = [...selected, 'vitest.company-backup.config.mts', 'package.json'];
const copied = new Set();
function save(file, text) {
  const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, text);
}
while (queue.length) {
  const file = queue.shift(); if (copied.has(file)) continue;
  if (/backup-(validation|restore)\.ts$/.test(file)) throw Error('Slice 1 depends on uncommitted DB core: ' + file);
  const text = selected.has(file) ? fs.readFileSync(path.join(repo,file),'utf8') : readHead(file);
  copied.add(file); save(file,text);
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  for (const { fileName: spec } of ts.preProcessFile(text,true,true).importedFiles) {
    const resolved = ts.resolveModuleName(spec,path.join(repo,file),options,ts.sys).resolvedModule;
    if (!resolved || resolved.isExternalLibraryImport) continue;
    const relative = path.relative(repo,resolved.resolvedFileName).replaceAll('\\','/');
    if (relative.startsWith('src/')) queue.push(relative);
    if (spec.endsWith('.mjs') && relative.endsWith('.d.mts')) queue.push(relative.slice(0,-6)+'.mjs');
  }
}
fs.symlinkSync(path.join(repo,'node_modules'),path.join(root,'node_modules'),'junction');
const config = JSON.parse(readHead('tsconfig.json'));
Object.assign(config.compilerOptions,{noEmit:true,incremental:false,target:'ES2022',module:'ESNext',moduleResolution:'bundler'});
config.include=['src/lib/db.ts','src/lib/backup.ts','src/lib/backup-format.ts','src/lib/backup-storage.ts','tests/backup-company/export.test.ts','tests/backup-company/helpers.ts'];config.exclude=[];
save('tsconfig.slice1.json',JSON.stringify(config,null,2));
console.log('SLICE1_COPY',root,'selected plus',copied.size-selected.size,'committed dependency/config files');
assert(!fs.existsSync(path.join(root,'src/lib/backup-validation.ts')));assert(!fs.existsSync(path.join(root,'src/lib/backup-restore.ts')));
for (const args of [
  [path.join(repo,'node_modules/vitest/vitest.mjs'),'run','--config','vitest.company-backup.config.mts','--configLoader','native','tests/backup-company/export.test.ts'],
  [path.join(repo,'node_modules/typescript/bin/tsc'),'--project','tsconfig.slice1.json','--noEmit','--incremental','false'],
]) {
  const result=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:25000});
  process.stdout.write(result.stdout ?? '');process.stderr.write(result.stderr ?? '');
  console.log('CHILD_EXIT',result.status);
  if(result.error || result.status!==0) throw result.error ?? Error('Standalone slice check failed');
}
const original=fs.readFileSync(path.join(approved,'verify-fidelity-L4LD9t/program/tests/backup-company/public-pg.verifier.test.ts'),'utf8');
assert.equal(crypto.createHash('sha256').update(original).digest('hex'),'6a079354829f50580b0fc42042d6c8cc3045456adfaa1e414b6e82d9db158eff');
const candidate=fs.readFileSync('tests/backup-company/public-pg.integration.ts','utf8');
const bodies=source=>ts.transpileModule(source.slice(source.indexOf("it('S2/S3/S4 real public")),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
assert.equal(bodies(candidate),bodies(original));
console.log('PASS: all three original PG probe bodies transpile identically; Slice 1 compiles/tests without DB-core files');
