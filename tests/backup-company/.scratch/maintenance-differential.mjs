import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
const { createMaintenanceGate } = await import(pathToFileURL(path.resolve(process.argv[2])).href);
const root = path.resolve('tests/backup-company/.scratch/differential-' + crypto.randomUUID());
const gate = createMaintenanceGate(root);
const results = [];
try {
  results.push(['initial', gate.status()]);
  results.push(['normal', await gate.withNormalOperation(async () => { results.push(['normal-status', gate.status()]); return gate.withNormalOperation(() => 'nested'); })]);
  results.push(['sync', gate.withRuntimeOperationSync(() => 7)]);
  const lease = gate.acquireNormalOperation();
  const owner = gate.beginMaintenance();
  try { gate.acquireNormalOperation(); } catch (e) { results.push(['denied',e.code,e.message]); }
  try { await owner.drain({timeoutMs:0}); } catch(e) { results.push(['drain',e.code,e.message]); }
  await lease.run(async () => results.push(['existing',gate.status()]));
  lease.release(); await owner.drain({timeoutMs:0});
  results.push(['recovery',await owner.runRecovery(() => gate.withRuntimeOperation(async () => gate.withRuntimeOperationSync(() => 9)))]);
  try { await owner.runRecovery(async()=>{throw new Error('probe');}); } catch(e) { results.push(['failure',e.message]); }
  owner.release(); results.push(['end',gate.status()]);
  console.log(JSON.stringify(results));
} finally { fs.rmSync(root,{recursive:true,force:true}); }
