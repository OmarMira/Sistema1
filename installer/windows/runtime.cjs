'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { preflight } = require('./preflight.cjs');
const MARKER = '.accountexpress-install.json';
function environment(extra = {}) {
  const clean = {};
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'PATH']) if (process.env[name]) clean[name] = process.env[name];
  return { ...clean, NEXT_TELEMETRY_DISABLED: '1', ...extra };
}
function contains(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}
function checkedRun(exe, args, env, cwd, capture = false) {
  const r = spawnSync(exe, args, { shell: false, cwd, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(path.basename(exe) + ' failed' + (r.status === null ? '' : ' (exit ' + r.status + ')'));
  return (r.stdout || '').trim();
}
function restrictDirectory(directory) {
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); return; }
  const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
  // Replace the DACL rather than retaining explicit grants on an existing empty folder.
  const command = "$ErrorActionPreference='Stop'; " +
    '$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; ' +
    '$acl=[System.Security.AccessControl.DirectorySecurity]::new(); ' +
    '$acl.SetOwner($owner); $acl.SetAccessRuleProtection($true,$false); ' +
    "foreach($sid in @($owner,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) { " +
    "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; " +
    'Set-Acl -LiteralPath $env:AE_PRIVATE_DATA -AclObject $acl';
  checkedRun(path.join(system, 'WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], environment({ AE_PRIVATE_DATA: directory }), directory, true);
}
function configure(app, data) {
  app = fs.realpathSync.native(app);
  if (!data || !path.isAbsolute(data)) throw new Error('An absolute separate data directory is required');
  data = path.resolve(data);
  if (contains(app, data) || contains(data, app)) throw new Error('Program and data directories must be separate');
  if (fs.existsSync(path.join(app, MARKER))) throw new Error('Installation is already configured');
  const check = preflight({ programDir: path.join(app, '.configure-probe-' + crypto.randomUUID()), dataDir: data, requiredProgramBytes: 1, requiredDataBytes: 1024 * 1024 * 512 });
  if (!check.ok) throw new Error('Data directory rejected: ' + check.code);
  data = check.dataDir;
  fs.mkdirSync(data, { recursive: true });
  restrictDirectory(data);
  const config = { version: 1, ownerId: crypto.randomUUID(), appDir: app, dataDir: data, sessionSecret: crypto.randomBytes(32).toString('base64'), hmacSecret: crypto.randomBytes(32).toString('hex'), identityKey: crypto.randomBytes(32).toString('base64'), databasePassword: crypto.randomBytes(32).toString('hex'), controlToken: crypto.randomBytes(32).toString('hex'), appPort: 32180 };
  fs.writeFileSync(path.join(data, 'instance.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(app, MARKER), JSON.stringify({ version: 1, ownerId: config.ownerId, dataDir: data }), { flag: 'wx' });
  return { configured: true, dataDir: data };
}
function readConfig(app) {
  const file = path.join(app, MARKER);
  if (!fs.existsSync(file)) return null;
  const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!marker.dataDir || !path.isAbsolute(marker.dataDir)) throw new Error('Invalid installed data path');
  const realData = fs.realpathSync.native(marker.dataDir);
  if (contains(app, realData) || contains(realData, app) || fs.lstatSync(marker.dataDir).isSymbolicLink()) throw new Error('Unsafe installed data path');
  const configFile = path.join(realData, 'instance.json');
  if (fs.lstatSync(configFile).isSymbolicLink()) throw new Error('Unsafe instance configuration');
  const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (cfg.version !== 1 || cfg.ownerId !== marker.ownerId || path.resolve(cfg.appDir).toLowerCase() !== path.resolve(app).toLowerCase()) throw new Error('Installation ownership mismatch');
  for (const key of ['sessionSecret', 'hmacSecret', 'identityKey', 'databasePassword', 'controlToken']) if (typeof cfg[key] !== 'string' || cfg[key].length < 32) throw new Error('Invalid private instance configuration');
  cfg.dataDir = realData; return cfg;
}
function requestControl(cfg, route) {
  const stateFile = path.join(cfg.dataDir, 'runtime.json');
  if (!fs.existsSync(stateFile)) return Promise.resolve(null);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (state.ownerId !== cfg.ownerId || !Number.isInteger(state.controlPort)) throw new Error('Runtime ownership mismatch');
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port: state.controlPort, path: route, method: route === '/stop' ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + cfg.controlToken }, timeout: 3000 }, res => {
      let body = ''; res.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
      res.on('end', () => { try { const result = JSON.parse(body); resolve(res.statusCode === 200 && result.ownerId === cfg.ownerId ? result : null); } catch { resolve(null); } });
    }); req.on('error', () => resolve(null)); req.on('timeout', () => req.destroy()); req.end();
  });
}
function availablePort(requested = 0) {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(requested, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
function postgres(app, cfg, command, args, capture = false) {
  return checkedRun(path.join(app, 'runtime/postgres/bin', command + '.exe'), args, environment({ PGPASSWORD: cfg.databasePassword, PGCONNECT_TIMEOUT: '5' }), app, capture);
}
async function start(app, cfg, requestedPort, openBrowser = false) {
  const lock = path.join(cfg.dataDir, 'runtime.lock');
  if (fs.existsSync(lock)) {
    const previous = JSON.parse(fs.readFileSync(lock, 'utf8'));
    if (previous.ownerId !== cfg.ownerId) throw new Error('Runtime lock ownership mismatch');
    let alive = true; try { process.kill(previous.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('This instance is already running or its lock needs inspection');
    fs.unlinkSync(lock);
  }
  const appPort = await availablePort(requestedPort ?? cfg.appPort);
  fs.writeFileSync(lock, JSON.stringify({ ownerId: cfg.ownerId, pid: process.pid }), { flag: 'wx', mode: 0o600 });
  let databaseStarted = false, child, control, stopping = false;
  const pgData = path.join(cfg.dataDir, 'postgres');
  const stateFile = path.join(cfg.dataDir, 'runtime.json');
  const stop = async () => {
    if (stopping) return; stopping = true;
    if (child && child.exitCode === null) {
      child.kill(); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); });
    }
    if (databaseStarted) { try { postgres(app, cfg, 'pg_ctl', ['-D', pgData, '-m', 'fast', '-w', '-t', '30', 'stop']); } catch { process.exitCode = 1; } }
    if (control) control.close();
    for (const file of [stateFile, lock]) if (fs.existsSync(file)) fs.unlinkSync(file);
  };
  try {
    for (const file of ['server.js', 'runtime/node/node.exe', 'runtime/postgres/bin/pg_ctl.exe', 'node_modules/prisma/build/index.js', 'prisma/schema.prisma']) if (!fs.existsSync(path.join(app, file))) throw new Error('Installed payload is incomplete: ' + file);
    const pgVersion = path.join(pgData, 'PG_VERSION');
    if (!fs.existsSync(pgVersion)) {
      if (fs.existsSync(pgData) && fs.readdirSync(pgData).length) throw new Error('Refusing to initialize an existing database directory');
      const passfile = path.join(cfg.dataDir, '.init-password-' + crypto.randomUUID());
      fs.writeFileSync(passfile, cfg.databasePassword + '\n', { flag: 'wx', mode: 0o600 });
      try { postgres(app, cfg, 'initdb', ['-D', pgData, '--username=accountexpress', '--encoding=UTF8', '--locale=C', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--pwfile=' + passfile, '--no-instructions']); }
      finally { fs.unlinkSync(passfile); }
    } else if (fs.readFileSync(pgVersion, 'utf8').trim() !== '16') throw new Error('This payload requires PostgreSQL 16; a database upgrade is not automatic');
    const dbPort = await availablePort();
    postgres(app, cfg, 'pg_ctl', ['-D', pgData, '-l', path.join(cfg.dataDir, 'postgres.log'), '-o', '-h 127.0.0.1 -p ' + dbPort, '-w', '-t', '30', 'start']);
    databaseStarted = true;
    const connection = ['-h', '127.0.0.1', '-p', String(dbPort), '-U', 'accountexpress'];
    const exists = postgres(app, cfg, 'psql', [...connection, '-d', 'postgres', '-tAc', "SELECT 1 FROM pg_database WHERE datname='accountexpress'"], true);
    if (exists !== '1') postgres(app, cfg, 'createdb', [...connection, 'accountexpress']);
    const env = environment({ NODE_ENV: 'production', DATABASE_URL: `postgresql://accountexpress:${cfg.databasePassword}@127.0.0.1:${dbPort}/accountexpress?schema=public`, SESSION_SECRET: cfg.sessionSecret, HMAC_SECRET: cfg.hmacSecret, IDENTITY_INFRASTRUCTURE_ENABLED: 'true', IDENTITY_VERIFICATION_HMAC_KEY: cfg.identityKey, ACCOUNTEXPRESS_MAIL_MODE: 'relay', ACCOUNTEXPRESS_DATA_DIR: cfg.dataDir, PORT: String(appPort), HOSTNAME: '127.0.0.1' });
    checkedRun(path.join(app, 'runtime/node/node.exe'), [path.join(app, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', path.join(app, 'prisma/schema.prisma')], env, app);
    child = spawn(path.join(app, 'runtime/node/node.exe'), [path.join(app, 'server.js')], { cwd: app, env, shell: false, stdio: 'inherit', windowsHide: true });
    child.once('error', () => { process.exitCode = 1; void stop(); });
    child.once('exit', code => { if (!stopping) { process.exitCode = code || 1; void stop(); } });
    control = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer ' + cfg.controlToken) { res.writeHead(403); res.end(); return; }
      if (!['/status', '/stop'].includes(req.url) || (req.url === '/stop' && req.method !== 'POST')) { res.writeHead(404); res.end(); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ownerId: cfg.ownerId, running: !stopping, url: 'http://127.0.0.1:' + appPort, pid: process.pid }));
      if (req.url === '/stop') void stop();
    });
    await new Promise((resolve, reject) => { control.once('error', reject); control.listen(0, '127.0.0.1', resolve); });
    fs.writeFileSync(stateFile, JSON.stringify({ ownerId: cfg.ownerId, controlPort: control.address().port, appPort }), { mode: 0o600 });
    process.once('SIGINT', () => void stop()); process.once('SIGTERM', () => void stop());
    const deadline = Date.now() + 60000;
    let ready = false;
    while (!stopping && Date.now() < deadline && child.exitCode === null) {
      ready = await new Promise(resolve => {
        const req = http.get({ host: '127.0.0.1', port: appPort, path: '/api/bootstrap/check', timeout: 1500 }, response => {
          let body = ''; response.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
          response.on('end', () => { try { const value = JSON.parse(body); resolve(response.statusCode === 200 && typeof value.empty === 'boolean' && typeof value.hasUsers === 'boolean'); } catch { resolve(false); } });
        }); req.on('error', () => resolve(false)); req.on('timeout', () => req.destroy());
      });
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    if (!ready) throw new Error('Application did not become ready; inspect the owned runtime logs');
    const url = 'http://127.0.0.1:' + appPort;
    console.log('ACCOUNTEXPRESS_URL=' + url);
    if (openBrowser && !stopping) {
      const browser = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/rundll32.exe'), ['url.dll,FileProtocolHandler', url], { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
      browser.on('error', () => console.error('Open the application at ' + url)); browser.unref();
    }
  } catch (error) { await stop(); throw error; }
}
module.exports = { configure, readConfig, requestControl, start, environment, MARKER };
