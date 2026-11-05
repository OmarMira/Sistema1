
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
// Original executed verifier SHA256:
// 6a079354829f50580b0fc42042d6c8cc3045456adfaa1e414b6e82d9db158eff
// Three probe bodies/assertions are retained; only fixture identity/storage is portable.
const fixture = vi.hoisted(() => {
  if (!process.env.COMPANY_RECOVERY_FIXTURE || !process.env.COMPANY_RECOVERY_VERIFIED_DESCRIPTOR) {
    throw new Error('Use vitest.company-backup-pg.config.mts with an explicit COMPANY_RECOVERY_FIXTURE');
  }
  return JSON.parse(process.env.COMPANY_RECOVERY_VERIFIED_DESCRIPTOR) as {
    root: string; pgdata: string; port: number; databaseUrl: string; dataDir: string;
  };
});
vi.mock('@/lib/auth', () => ({ hashPassword: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { slowQuery: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/metrics', () => ({ trackQueryDuration: vi.fn() }));
import { db, withCompanyBackupTransaction } from '@/lib/db';
import { createBackup, getBackupFile } from '@/lib/backup';
import { previewCompanyRestore, restoreCompanyBackup, restoreCompanyBackupCoordinated } from '@/lib/backup-restore';
import { sealSnapshot } from '@/lib/backup-format';
import { beginMaintenance, maintenanceStatus } from '@/lib/backup-maintenance.ts';
import { BACKUP_DIR } from '@/lib/config/paths';
/**
 * S1/S2/S7: the snapshot under test is the real exporter output and every
 * restore must prove the creating administrator's credential. Fixtures, probes
 * and assertions are otherwise untouched.
 */
const OWNER_PASSWORD = 'Clave.PublicPg.2026';
const raw = new PrismaClient();
const prefix = 'verify_' + crypto.randomUUID().replaceAll('-', '');
const ids = Object.fromEntries(['a','b','u','ga','gb','bank','statement','entry','line','tx','recon','ruleD','ruleJ','knowledge','audit1','audit2'].map(k => [k, prefix+'_'+k]));
const date = new Date('2026-01-01T00:00:00.000Z');
const max = '9999999999999999.99', min = '-9999999999999999.99';
let saved:any,source:any; const evidence:any={ids,rejections:[]};
let identityVerified = false;
async function identityGuard() {
 expect(process.env.DATABASE_URL).toBe(fixture.databaseUrl);
 const d:any = await raw.$queryRawUnsafe('SHOW data_directory');
 const i:any = await raw.$queryRawUnsafe("SELECT current_database() db, current_setting('server_version') version, host(inet_server_addr()) host, inet_server_port() port");
 expect(fs.realpathSync(d[0].data_directory)).toBe(fixture.pgdata);
 expect(i[0]).toMatchObject({db:'accountexpress_test',host:'127.0.0.1',port:fixture.port});
 expect(i[0].version.startsWith('16.')).toBe(true); console.log('PG_IDENTITY',JSON.stringify({d,i}));
 identityVerified = true;
}
async function fingerprint(models?: string[]) { if (!models) { const tables:any = await raw.$queryRawUnsafe("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"); models=tables.map((t:any)=>t.tablename); }
 const result:any = {};
 for (const name of models!) result[name] = await raw.$queryRawUnsafe('SELECT row_to_json(t)::text value FROM "'+name+'" t ORDER BY row_to_json(t)::text');
 return crypto.createHash('sha256').update(JSON.stringify(result)).digest('hex');
}
function backupBytes() { return fs.readdirSync(BACKUP_DIR).sort().map(n=>[n,crypto.createHash('sha256').update(fs.readFileSync(path.join(BACKUP_DIR,n))).digest('hex')]); }
function gateBytes() { const root=path.join(process.env.ACCOUNTEXPRESS_DATA_DIR!, 'config','backup-maintenance'); const rows:any[]=[];function walk(dir:string){for(const n of fs.readdirSync(dir).sort()){const f=path.join(dir,n);if(fs.statSync(f).isDirectory())walk(f);else rows.push([path.relative(root,f),crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]);}}walk(root);return rows;}
async function foreignState() {
 return JSON.stringify({global:await fingerprint(['User','Session','SystemConfig','BankProfile','RateLimit','IdentityPendingRegistration','IdentityChallenge','IdentityRateLimit','IdentitySecurityEvent']),company:await raw.company.findUnique({where:{id:ids.b}}),gl:await raw.glAccount.findMany({where:{companyId:ids.b}}),members:await raw.companyMember.findMany({where:{companyId:ids.b}})});
}
beforeAll(async()=>{
 await identityGuard();
 fs.mkdirSync(fixture.dataDir, { recursive: true });
 await raw.company.create({data:{id:ids.a,legalName:'Compañía Ñ € 中文 😀'}});
 await raw.company.create({data:{id:ids.b,legalName:'Untouched company'}});
 await raw.user.create({data:{id:ids.u,email:prefix+'@example.invalid',passwordHash:'synthetic-not-a-real-credential',firstName:'Shared',lastName:'Identity'}});
 for(const companyId of [ids.a,ids.b]) await raw.companyMember.create({data:{companyId,userId:ids.u,role:'company_admin'}});
 await raw.systemConfig.create({data:{key:prefix,value:'global-preserved'}});
 await raw.session.create({data:{userId:ids.u,token:prefix,expiresAt:new Date('2030-01-01')}});
 for(const [id,companyId,balance] of [[ids.ga,ids.a,max],[ids.gb,ids.b,'4.25']]) await raw.glAccount.create({data:{id,companyId,balance,code:'100',name:'Cash',accountType:'asset',normalBalance:'debit'}});
 for(const [i,balance] of [max,min,'0.01','-0.01','0.00'].entries()) await raw.glAccount.create({data:{id:prefix+'_cent_'+i,companyId:ids.a,balance,code:'cent'+i,name:'Boundary',accountType:'asset',normalBalance:'debit'}});

 await raw.bankAccount.create({data:{id:ids.bank,companyId:ids.a,glAccountId:ids.ga,accountName:'Bank',bankName:'Synthetic',balance:min,initialBalance:'0.01'}});
 await raw.bankStatement.create({data:{id:ids.statement,companyId:ids.a,bankAccountId:ids.bank,startDate:date,endDate:date,format:'CSV',openingBalance:max,closingBalance:min,totalCredits:'0.01',totalDebits:'0.00'}});
 await raw.reconciliationPeriod.create({data:{id:ids.recon,companyId:ids.a,bankAccountId:ids.bank,userId:ids.u,statementBalance:max,bookBalance:min,difference:'-0.01'}});
 await raw.journalEntry.create({data:{id:ids.entry,companyId:ids.a,date,description:'Draft only',status:'draft'}});
 await raw.journalLine.create({data:{id:ids.line,entryId:ids.entry,glAccountId:ids.ga,debit:max,credit:'0.01'}});
 await raw.bankTransaction.create({data:{id:ids.tx,statementId:ids.statement,date,description:'Linked draft',amount:min,journalEntryId:ids.entry,journalLineId:ids.line,glAccountId:ids.ga,reconciliationPeriodId:ids.recon}});
 for(const [id,conditions] of [[ids.ruleD,Prisma.DbNull],[ids.ruleJ,Prisma.JsonNull]] as const) await raw.bankRule.create({data:{id,companyId:ids.a,name:'Null provenance',conditionType:'contains',conditionValue:'x',conditions}});
 await raw.companyKnowledge.create({data:{id:ids.knowledge,companyId:ids.a,type:'PERSON',canonicalName:'Nested',aliases:[],metadata:{nested:null,list:[null]}}});
 await raw.knowledgeAudit.create({data:{id:ids.audit1,knowledgeId:ids.knowledge,action:'test',version:1,beforeValue:Prisma.DbNull,afterValue:Prisma.JsonNull,changedByUserId:ids.u,source:'test',reason:'test'}});
 await raw.knowledgeAudit.create({data:{id:ids.audit2,knowledgeId:ids.knowledge,action:'test',version:2,beforeValue:Prisma.JsonNull,afterValue:Prisma.DbNull,changedByUserId:ids.u,source:'test',reason:'test'}});
 console.log('SEEDED',JSON.stringify(ids));
},25000);
afterAll(async()=>{if(identityVerified) fs.writeFileSync(path.join(fixture.dataDir, 'pg-evidence.json'),JSON.stringify(evidence,null,2));await raw.$disconnect();await db.$disconnect();});
it('S2/S3/S4 real public roundtrip all 13 columns and NULL kinds',async()=>{
 const foreign=await foreignState();
 saved=await createBackup(ids.a, undefined, { ownerPassword: OWNER_PASSWORD }); const text=getBackupFile(saved.filename)!.data;
 expect(Buffer.from(saved.data,'base64').toString('utf8')).toBe(text); source=JSON.parse(text);
 const monetary:any[]=[];
 const modelIds:any={GlAccount:ids.ga,BankAccount:ids.bank,BankStatement:ids.statement,BankTransaction:ids.tx,ReconciliationPeriod:ids.recon,JournalLine:ids.line};
 for(const m of Prisma.dmmf.datamodel.models) for(const f of m.fields.filter(f=>f.type==='Decimal')) {
  const section=Object.keys(source.data).find(k=>Array.isArray(source.data[k])&&source.data[k].some((r:any)=>r.id===modelIds[m.name]));
  expect(section,m.name+'.'+f.name).toBeTruthy(); const row=source.data[section!].find((r:any)=>r.id===modelIds[m.name]);
  expect(typeof row[f.name]).toBe('string'); monetary.push([m.name,f.name,row.id,row[f.name]]);
 }
 expect(monetary).toHaveLength(13);
 expect(source.data.glAccounts.filter((r:any)=>r.code.startsWith('cent')).map((r:any)=>r.balance).sort()).toEqual([max,min,'0.01','-0.01','0.00'].sort());
 const previewBefore=await fingerprint(), bytes=backupBytes();
 expect((await previewCompanyRestore(ids.a,text)).blockers).toEqual([]);
 expect(await fingerprint()).toBe(previewBefore);expect(backupBytes()).toEqual(bytes);
 await raw.glAccount.update({where:{id:ids.ga},data:{balance:'0.01'}});
 const result=await restoreCompanyBackup(ids.a,text,{ ownerPassword: OWNER_PASSWORD });expect(result.status,JSON.stringify(result)).toBe('committed');
 for(const [model,field,id,value] of monetary) {const row:any=await (raw as any)[model[0].toLowerCase()+model.slice(1)].findUnique({where:{id}});expect(row[field].toFixed(2),model+'.'+field).toBe(value);}
 expect(await raw.bankTransaction.findUnique({where:{id:ids.tx}})).toMatchObject({journalEntryId:ids.entry,journalLineId:ids.line,reconciliationPeriodId:ids.recon});
 const rules:any=await raw.$queryRawUnsafe('SELECT id, (conditions IS NULL) sqlnull, (conditions = '+"'null'"+'::jsonb) jsonnull FROM "BankRule" WHERE id IN ($1,$2)',ids.ruleD,ids.ruleJ);
 expect(rules.find((r:any)=>r.id===ids.ruleD)).toMatchObject({sqlnull:true,jsonnull:null});
 expect(rules.find((r:any)=>r.id===ids.ruleJ)).toMatchObject({sqlnull:false,jsonnull:true});
 const audits:any=await raw.$queryRawUnsafe('SELECT id, ("beforeValue" IS NULL) bs, ("beforeValue" = '+"'null'"+'::jsonb) bj, ("afterValue" IS NULL) asql, ("afterValue" = '+"'null'"+'::jsonb) aj FROM "KnowledgeAudit" WHERE id IN ($1,$2)',ids.audit1,ids.audit2);
 expect(audits.find((r:any)=>r.id===ids.audit1)).toMatchObject({bs:true,bj:null,asql:false,aj:true});
 expect(audits.find((r:any)=>r.id===ids.audit2)).toMatchObject({bs:false,bj:true,asql:true,aj:null});
 expect((await raw.companyKnowledge.findUnique({where:{id:ids.knowledge}}))!.metadata).toEqual({nested:null,list:[null]});
 expect(await foreignState()).toBe(foreign);expect(getBackupFile(saved.filename)!.data).toBe(text);
 const safety=JSON.parse(getBackupFile(result.safetyFilename)!.data);expect(safety.data.glAccounts.find((r:any)=>r.id===ids.ga).balance).toBe('0.01');
 expect(safety.manifest.fidelity).toEqual(source.manifest.fidelity);
 expect(await raw.auditLog.findUnique({where:{id:result.operationId}})).toMatchObject({action:'COMPANY_RESTORE_COMMITTED',companyId:ids.a});
 evidence.money=monetary; evidence.nulls={rules,audits}; console.log('PROVEN_MONEY',JSON.stringify(monetary),'PROVEN_NULLS',JSON.stringify({rules,audits}));
},25000);

it('S3/S4 genuine lazy, array, interactive, fluent, raw helper and extension maintenance contracts',async()=>{
 const lazy=db.glAccount.findUniqueOrThrow({where:{id:ids.ga}});
 expect(lazy[Symbol.toStringTag]).toBe('PrismaPromise');
 expect(typeof (await lazy).balance).toBe('number');
 expect(typeof (await db.$transaction([db.glAccount.findUniqueOrThrow({where:{id:ids.ga}})],{isolationLevel:'RepeatableRead'}))[0].balance).toBe('number');
 await db.$transaction(async tx=>{expect(typeof (await tx.glAccount.findUniqueOrThrow({where:{id:ids.ga}})).balance).toBe('number');},{isolationLevel:'Serializable',maxWait:1234,timeout:5000});
 expect((await db.company.findUnique({where:{id:ids.a}}).members())!.some(r=>r.userId===ids.u)).toBe(true);
 await withCompanyBackupTransaction(async tx=>{expect(maintenanceStatus().leases).toBe(1);expect((await tx.glAccount.findUniqueOrThrow({where:{id:ids.ga}})).balance).toBeInstanceOf(Prisma.Decimal); const isolation:any=await tx.$queryRawUnsafe('SHOW transaction_isolation'); expect(isolation[0].transaction_isolation).toBe('serializable');},{isolationLevel:'Serializable',maxWait:1234,timeout:5000});
 const extensions=db.$extends({client:{purge(this:typeof db){return this.glAccount.deleteMany({where:{id:ids.ga}});},$purge(this:typeof db){return this.glAccount.deleteMany({where:{id:ids.ga}});}}});
 const pending=db.glAccount.findMany({where:{id:ids.ga}}), fluent=db.company.findUnique({where:{id:ids.a}}).members();
 const owner=beginMaintenance();await owner.drain({timeoutMs:1000});
 const baseline=await fingerprint();const marker=maintenanceStatus();const markerBytes=gateBytes();
 try {
  for(const operation of [()=>pending,()=>fluent,()=>db.$transaction([db.glAccount.findMany()]),()=>db.$transaction(async tx=>tx.glAccount.findMany()),()=>extensions.purge(),()=>extensions.$purge(),()=>withCompanyBackupTransaction(async tx=>tx.glAccount.findMany())]) await expect(Promise.resolve().then(operation as () => unknown)).rejects.toMatchObject({code:'BACKUP_MAINTENANCE'});
  expect(await fingerprint()).toBe(baseline);expect(maintenanceStatus()).toEqual(marker);expect(gateBytes()).toEqual(markerBytes);
  await owner.runRecovery(()=>withCompanyBackupTransaction(async tx=>{expect((await tx.glAccount.findUniqueOrThrow({where:{id:ids.ga}})).balance.toFixed(2)).toBe(max);}));
 } finally {owner.release();}
},25000);
it('S2/S4 coordinates real DB/config/logo recovery and reconciles a crashed owner through the public operator', async () => {
  const logoUrl = '/uploads/logos/' + Date.now() + '-' + crypto.randomUUID() + '.png';
  const logoPath = path.join(fixture.dataDir, 'uploads', 'logos', path.basename(logoUrl));
  const configPath = path.join(fixture.dataDir, 'config', 'company-config.json');
  fs.mkdirSync(path.dirname(logoPath), { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const logoBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6hQAAAAASUVORK5CYII=', 'base64');
  fs.writeFileSync(logoPath, logoBytes);
  const config = { marker: 'preserve-global', companies: { [ids.a]: { currency: 'ARS' }, [ids.b]: { currency: 'EUR' } } };
  fs.writeFileSync(configPath, JSON.stringify(config));
  await raw.company.update({ where: { id: ids.a }, data: { logo: logoUrl } });
  const archive = await createBackup(ids.a, undefined, { ownerPassword: OWNER_PASSWORD });
  const archiveText = getBackupFile(archive.filename)!.data;
  expect(JSON.parse(archiveText).manifest.companyLogo.base64).toBe(logoBytes.toString('base64'));
  const foreign = await foreignState();
  fs.writeFileSync(logoPath, 'changed-logo');
  fs.writeFileSync(configPath, JSON.stringify({ ...config, companies: { ...config.companies, [ids.a]: { currency: 'USD' } } }));
  await raw.glAccount.update({ where: { id: ids.ga }, data: { balance: '0.01' } });
  const restored = await restoreCompanyBackupCoordinated(ids.a, archiveText, { ownerPassword: OWNER_PASSWORD });
  expect(restored.status, JSON.stringify(restored)).toBe('committed');
  expect(fs.readFileSync(logoPath)).toEqual(logoBytes);
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(config);
  expect((await raw.glAccount.findUniqueOrThrow({ where: { id: ids.ga } })).balance.toFixed(2)).toBe(max);
  expect(await foreignState()).toBe(foreign);
  const safety = JSON.parse(getBackupFile(restored.safetyFilename)!.data);
  expect(safety.manifest.companyLogo.base64).toBe(Buffer.from('changed-logo').toString('base64'));
  expect(safety.data.companyConfig).toEqual({ currency: 'USD' });

  // Real DB commit, controlled post-commit filesystem failure, then an actual
  // child-process exit while owning recovery. Only synthetic fixture state.
  fs.writeFileSync(logoPath, 'second-old-logo');
  fs.writeFileSync(configPath, JSON.stringify({ ...config, companies: { ...config.companies, [ids.a]: { currency: 'USD' } } }));
  const configBefore = fs.readFileSync(configPath);
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === configPath) throw Object.assign(new Error('synthetic post-commit failure'), { code: 'EIO' });
    return rename(from, to);
  });
  let interrupted;
  try { interrupted = await restoreCompanyBackupCoordinated(ids.a, archiveText, { ownerPassword: OWNER_PASSWORD }); } finally { spy.mockRestore(); }
  expect(interrupted.status, JSON.stringify(interrupted)).toBe('reconciliation_required');
  expect(fs.readFileSync(configPath)).toEqual(configBefore);
  const journal = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'config', 'backup-recovery', interrupted.operationId + '.json'), 'utf8')).payload;
  const gateRoot = path.join(fixture.dataDir, 'config', 'backup-maintenance');
  const moduleUrl = pathToFileURL(path.resolve('src/lib/backup-maintenance.mjs')).href;
  const crashSource = `import fs from 'node:fs';import {createMaintenanceGate} from ${JSON.stringify(moduleUrl)};const gate=createMaintenanceGate(${JSON.stringify(gateRoot)});const owner=gate.resumeMaintenance(${JSON.stringify(journal.maintenanceId)});await owner.drain({timeoutMs:0});await owner.runRecovery(async()=>{fs.writeSync(1,'LOCKHELD\\n');process.exit(23);});`;
  const crashed = spawnSync(process.execPath, ['--input-type=module', '-'], { input: crashSource, encoding: 'utf8', timeout: 5000 });
  expect(crashed.status, crashed.stderr).toBe(23); expect(crashed.stdout).toBe('LOCKHELD\n');
  const script = path.resolve('scripts/company-recovery.mjs');
  const env = { ...process.env, ACCOUNTEXPRESS_DATA_DIR: fixture.dataDir, DATABASE_URL: fixture.databaseUrl };
  const inspect = spawnSync(process.execPath, [script, 'inspect', '--operation', interrupted.operationId], { env, encoding: 'utf8', timeout: 5000 });
  expect(inspect.status, inspect.stderr).toBe(0);
  const inspection = JSON.parse(inspect.stdout);
  expect(inspection.recoveryLockSha256).toMatch(/^[a-f0-9]{64}$/);
  const reconciled = spawnSync(process.execPath, [script, 'reconcile', '--operation', interrupted.operationId, '--maintenance-id', journal.maintenanceId,
    '--lock-sha256', inspection.recoveryLockSha256, '--confirm-stopped'], { env, encoding: 'utf8', timeout: 25000 });
  expect(reconciled.status, reconciled.stderr).toBe(0);
  expect(JSON.parse(reconciled.stdout)).toMatchObject({ status: 'committed', operationId: interrupted.operationId });
  expect(fs.readFileSync(logoPath)).toEqual(logoBytes);
  expect(JSON.parse(fs.readFileSync(configPath, 'utf8'))).toEqual(config);
  expect(await foreignState()).toBe(foreign);
  expect(getBackupFile(archive.filename)!.data).toBe(archiveText);
  expect(fs.existsSync(path.join(gateRoot, 'maintenance.json'))).toBe(false);
  expect(fs.existsSync(path.join(gateRoot, 'recovery.json'))).toBe(false);
  evidence.coordinated = { operationId: interrupted.operationId, childExit: crashed.status, operatorExit: reconciled.status };
}, 25000);

it('S3/S4 rejected future, truncated, provenance, corrupt and wrong-company inputs preserve DB and bytes',async()=>{
 expect(source).toBeTruthy();
 const cases:Array<[string,string]> = [];
 for(const [name,edit] of [ ['future',(s:any)=>s.manifest.version='9.0.0'],['provenance',(s:any)=>delete s.manifest.fidelity],['wrong-company',(s:any)=>s.manifest.companyId=ids.b] ] as const) {const s=structuredClone(source);edit(s);sealSnapshot(s);cases.push([name,JSON.stringify(s)]);}
 cases.push(['truncated',JSON.stringify(source).slice(0,-10)]);
 const corrupt=structuredClone(source);corrupt.data.company[0].legalName='corrupt';cases.push(['corrupt',JSON.stringify(corrupt)]);
 for(const [name,text] of cases) {
  const before=await fingerprint(), bytes=backupBytes();
  for(const command of [previewCompanyRestore,restoreCompanyBackup]) {let error='';try{await command(ids.a,text);}catch(e){error=String(e);}expect(error,name).not.toBe(''); evidence.rejections.push({name,command:command.name,error}); if(name==='future') expect(error).toBe('Error: Unsupported or invalid backup format'); if(name==='provenance') expect(error).toBe('Error: RESTORE_FIDELITY: 2.1.0 requires typed monetary and JSON null metadata'); if(name==='wrong-company') expect(error).toBe('Error: Invalid backup company identity or metadata'); if(name==='corrupt') expect(error).toBe('Error: Backup checksum or metadata mismatch'); console.log('REJECT',name,command.name,error);expect(await fingerprint()).toBe(before);expect(backupBytes()).toEqual(bytes);}
 }
},25000);
