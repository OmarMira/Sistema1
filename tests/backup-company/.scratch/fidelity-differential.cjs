// Ephemeral compatibility probe only: never imported by committed tests.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const { Prisma } = require('@prisma/client');
const assert = require('node:assert/strict');
const root = fs.mkdtempSync(path.resolve('tests/backup-company/.scratch/differential-'));
const sources = {};
for (const name of ['backup', 'db']) sources[name] = execFileSync('git', ['show', `HEAD:src/lib/${name}.ts`], { encoding: 'utf8' });
function loader(baseline, dir, database) {
  const cache = new Map();
  function load(name) {
    if (cache.has(name)) return cache.get(name).exports;
    const module = { exports: {} }; cache.set(name, module);
    const file = path.resolve('src/lib', name + '.ts');
    const source = baseline && sources[name] ? sources[name] : fs.readFileSync(file, 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    function dependency(id) {
      if (id === '@/lib/db') return database;
      if (id === '@prisma/client') return { Prisma, PrismaClient: FakeClient };
      if (id.includes('backup-maintenance')) return { withRuntimeOperation: fn => fn() };
      if (id.includes('config/paths')) return { BACKUP_DIR: dir, RUNTIME_FILES: { companyConfig: path.join(dir, 'absent-config') } };
      if (id.includes('logger')) return { logger: { slowQuery() {}, info() {}, error() {}, warn() {} } };
      if (id.includes('metrics')) return { trackQueryDuration() {} };
      if (id.includes('auth')) return { hashPassword() { throw Error('auth forbidden'); } };
      if (id.includes('ai-config')) return { AI_CONFIG: { STORAGE_KEYS_SET: new Set() } };
      if (id.includes('journal-hash')) return { buildChainVerdict() { throw Error('chain forbidden'); } };
      if (id.startsWith('./backup-')) return load(id.slice(2));
      return require(id);
    }
    vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {
      Buffer, URL, console, process: { env: { NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic/accountexpress_test', NEXT_RUNTIME: 'edge' } },
      globalThis: {}, setTimeout, clearTimeout,
    }, { filename: file })(dependency, module, module.exports);
    return module.exports;
  }
  return load;
}
class FakeClient {
  constructor(overrides) { this.overrides = overrides; }
  $extends(extension) { return new FakeClient(extension.result); }
  $on() {}
  $transaction(callback) { return callback(this); }
  get glAccount() { return this.delegate('glAccount', 'balance'); }
  get bankTransaction() { return this.delegate('bankTransaction', 'amount'); }
  delegate(model, field) {
    return { findMany: () => ({ then: (resolve, reject) => Promise.resolve().then(() => {
      const value = new Prisma.Decimal('10.01');
      return [{ [field]: this.overrides?.[model]?.[field] ? this.overrides[model][field].compute({ [field]: value }) : value }];
    }).then(resolve, reject) }) };
  }
}
async function capture(fn) {
  try { return { exit: 0, stdout: JSON.stringify(await fn()), stderr: '' }; }
  catch (error) { return { exit: 1, stdout: '', stderr: String(error.message) }; }
}
(async () => {
  let matches = 0;
  try {
    for (const version of ['1.0.0', '1.1.0', '2.0.0']) {
      const runs = [];
      for (const baseline of [true, false]) {
        const dir = path.join(root, `${version}-${baseline}`); fs.mkdirSync(dir);
        const api = loader(baseline, dir, {})('backup');
        const sections = ['company','glAccounts','bankAccounts','bankStatements','bankTransactions','bankRules','journalEntries','journalLines','fiscalPeriods','companyMembers','users','systemConfig','reconciliationPeriods','companyKnowledge','knowledgeAudit','systemMemories','memoryItems','memoryVersions','relationships','contradictions','evolutionLinks','traceabilityLogs','confidenceLogs','entityContexts','detectionConfigs','companyModuleEntitlements','csvLayoutProfiles','ruleApplyRecords','ruleExecutionAudits','auditLogs','pendingApprovals'];
        const data = Object.fromEntries(sections.map(s => [s, []]));
        data.company = [{ id: 'tenant', legalName: 'Legacy Ñ', taxId: null }]; data.companyConfig = null; data.journalChainHead = null;
        const id = '11111111-1111-4111-8111-111111111111', filename = `legacy-${version}.json`;
        const counts = { ...Object.fromEntries(sections.map(s => [s, data[s].length])), companyConfig: false };
        const snapshot = { manifest: { version, id, companyId: 'tenant', createdAt: '2026-01-01T00:00:00.000Z', companyInfo: { id: 'tenant', legalName: 'Legacy Ñ', taxId: null }, recordCounts: counts }, data };
        if (version === '2.0.0') loader(false, dir, {})('backup-format').sealSnapshot(snapshot);
        const raw = JSON.stringify(snapshot), size = Buffer.byteLength(raw);
        fs.writeFileSync(path.join(dir, filename), raw);
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ backups: [{ id, filename, companyId: 'tenant', createdAt: snapshot.manifest.createdAt, companyLegalName: 'Legacy Ñ', size, recordCounts: counts }] }));
        runs.push([
          await capture(() => api.listBackups('tenant')),
          await capture(() => api.getBackupFile(filename)),
          await capture(() => api.deleteBackup(filename, 'other')),
          await capture(() => api.deleteBackup(filename, 'tenant')),
          await capture(() => api.getBackupFile(filename)),
        ]);
      }
      assert.deepEqual(runs[1], runs[0]); matches += runs[0].length;
      console.log(`${version}: list / exact-byte download / foreign delete / owned delete / absent download match exit+stdout+stderr`);
    }
    const runs = [];
    for (const baseline of [true, false]) {
      const api = loader(baseline, root, {})('db');
      runs.push([
        await capture(async () => { const value = (await api.db.glAccount.findMany({ select: { balance: true } }))[0].balance; return [typeof value, value]; }),
        await capture(async () => { const value = (await api.db.bankTransaction.findMany({ select: { amount: true } }))[0].amount; return [typeof value, value]; }),
        await capture(() => api.db.$transaction(async tx => { const value = (await tx.glAccount.findMany())[0].balance; return [typeof value, value]; })),
      ]);
    }
    assert.deepEqual(runs[1], runs[0]); matches += runs[0].length;
    assert.equal(runs[1][0].stdout, '["number",10.01]');
    console.log('db Number results and interactive transaction: match exit+stdout+stderr');
    console.log(`PASS ${matches} baseline/candidate contracts; no PostgreSQL connection`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
