'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const http = require('node:http');
const { environment } = require('./runtime.cjs');
async function acceptance(installer, withBrowser = false) {
  installer = path.resolve(installer);
  if (!fs.existsSync(installer)) throw new Error('Installer does not exist');
  const base = path.join(__dirname, '.checks'); fs.mkdirSync(base, { recursive: true });
  const work = fs.mkdtempSync(path.join(base, 'installed-proof-'));
  const app = path.join(work, 'Program with spaces'), data = path.join(work, 'Accounting data');
  fs.writeFileSync(path.join(work, '.owned-acceptance'), crypto.randomUUID(), { flag: 'wx' });
  const temporary = path.join(work, 'temporary'); fs.mkdirSync(temporary);
  const env = environment({ TEMP: temporary, TMP: temporary }); const evidence = { work, installer, installation: false, migrationsAndStart: false, restart: false, malformedVerificationRejected: false, mailFailsClosed: false, uninstallRetainsData: false };
  let running;
  const execute = (exe, args) => {
    const r = spawnSync(exe, args, { env, shell: false, encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(path.basename(exe) + ' failed: ' + (r.error?.message || r.status) + '\n' + r.stdout + '\n' + r.stderr);
    return r.stdout;
  };
  const node = path.join(app, 'runtime/node/node.exe'), launcher = path.join(app, 'launcher.cjs');
  const start = number => new Promise((resolve, reject) => {
    const log = fs.createWriteStream(path.join(work, 'runtime-' + number + '.log'));
    const child = spawn(node, [launcher, '--start', '--port', '0'], { env, cwd: app, shell: false, windowsHide: true });
    running = child;
    let tail = '', settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('Installed runtime readiness exceeded120s; see ' + work)); } }, 120000);
    child.stdout.on('data', chunk => {
      log.write(chunk); tail = (tail + chunk.toString()).slice(-8192);
      const ready = tail.match(/ACCOUNTEXPRESS_URL=(http:\/\/127\.0\.0\.1:\d+)/);
      if (ready && !settled) { settled = true; clearTimeout(timer); resolve(ready[1]); }
    });
    child.stderr.on('data', chunk => log.write(chunk));
    child.once('error', error => { clearTimeout(timer); if (!settled) { settled = true; reject(error); } });
    child.once('close', code => { log.end(); clearTimeout(timer); if (!settled) { settled = true; reject(new Error('Installed runtime exited ' + code + '; see ' + work)); } });
  });
  const request = (url, body) => new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, timeout: 15000 }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; if (text.length > 1000000) req.destroy(); }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    }); req.once('error', reject); req.once('timeout', () => req.destroy(new Error('HTTP timeout'))); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const stop = async () => {
    if (!running || running.exitCode !== null) return;
    const child = running;
    const exited = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Owned runtime did not stop')), 20000); child.once('close', () => { clearTimeout(timer); resolve(); }); });
    execute(node, [launcher, '--stop']); await exited; running = undefined;
  };
  try {
    execute(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOICONS', '/DIR=' + app, '/DATADIR=' + data, '/LOG=' + path.join(work, 'install.log')]);
    assert.ok(fs.existsSync(path.join(app, 'server.js'))); assert.ok(fs.existsSync(path.join(data, 'instance.json'))); evidence.installation = true;
    const originalConfig = fs.readFileSync(path.join(data, 'instance.json'));
    fs.writeFileSync(path.join(data, 'retention-proof.txt'), 'owned-acceptance-retain');
    const first = await start(1);
    const bootstrap = await request(first + '/api/bootstrap/check');
    assert.equal(bootstrap.status, 200); assert.deepEqual(JSON.parse(bootstrap.text), { empty: true, hasUsers: false }); evidence.migrationsAndStart = true;
    const page = await request(first + '/'); assert.equal(page.status, 200);
    const image = await request(first + '/hero-dashboard.png'); assert.equal(image.status, 200); assert.match(image.headers['content-type'], /image\//);
    if (withBrowser) evidence.browser = await require('./browser-proof.cjs').browserProof(first, work);
    const verification = await request(first + '/api/auth/verify', { email: 'installer-proof@example.invalid', code: 'invalid' });
    assert.equal(verification.status, 400); assert.equal(JSON.parse(verification.text).code, 'INVALID_VERIFICATION_INPUT');
    assert.deepEqual(JSON.parse((await request(first + '/api/bootstrap/check')).text), { empty: true, hasUsers: false }); evidence.malformedVerificationRejected = true;
    const registration = await request(first + '/api/auth/register', { email: 'installer-proof@example.invalid', password: 'IsolatedProofPassword1!', firstName: 'Installer', lastName: 'Proof', companyName: 'Isolated proof company', entityType: 'BUSINESS' });
    assert.equal(registration.status, 200); assert.deepEqual(JSON.parse(registration.text), { requiresVerification: true, deliveryFailed: true, email: 'installer-proof@example.invalid' });
    assert.equal(registration.headers['set-cookie'], undefined); assert.deepEqual(JSON.parse((await request(first + '/api/bootstrap/check')).text), { empty: true, hasUsers: false }); evidence.mailFailsClosed = true;
    await stop(); assert.deepEqual(fs.readFileSync(path.join(data, 'instance.json')), originalConfig);
    const second = await start(2); assert.deepEqual(JSON.parse((await request(second + '/api/bootstrap/check')).text), { empty: true, hasUsers: false });
    assert.equal(fs.readFileSync(path.join(data, 'retention-proof.txt'), 'utf8'), 'owned-acceptance-retain');
    assert.deepEqual(fs.readFileSync(path.join(data, 'instance.json')), originalConfig); evidence.restart = true;
    await stop();
    execute(path.join(app, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + path.join(work, 'uninstall.log')]);
    assert.equal(fs.existsSync(path.join(app, 'server.js')), false);
    assert.deepEqual(fs.readFileSync(path.join(data, 'instance.json')), originalConfig);
    assert.equal(fs.readFileSync(path.join(data, 'retention-proof.txt'), 'utf8'), 'owned-acceptance-retain'); evidence.uninstallRetainsData = true;
    fs.writeFileSync(path.join(base, 'acceptance-result.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await stop();
    fs.writeFileSync(path.join(work, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
}
if (![4, 5].includes(process.argv.length) || process.argv[2] !== '--installer' || process.argv.length === 5 && process.argv[4] !== '--browser') { console.error('Usage: node acceptance.cjs --installer <AccountExpress-Setup.exe> [--browser]\nRuns silent installation/start/restart/uninstall only in new owned project paths; no icons, registry registration, ambient DB or real mail.'); process.exitCode = 2; }
else acceptance(process.argv[3], process.argv[4] === '--browser').catch(error => { console.error(error.stack); process.exitCode = 1; });
