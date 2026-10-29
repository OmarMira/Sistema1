'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { configure, readConfig, requestControl, start } = require('./runtime.cjs');
async function main(args) {
  const commands = ['--configure', '--start', '--stop', '--restart', '--status'];
  if (!args.length || args.length === 1 && args[0] === '--help') {
    console.log('AccountExpress installed runtime\n  node launcher.cjs --configure --data-dir <new-separate-absolute-folder>\n  node launcher.cjs --start [--port <1..65535|0>] [--open]\n  node launcher.cjs --status | --stop | --restart\n  --app-dir <folder> selects the owned installed payload (default: script directory).\nStart remains active until stopped. All listeners bind to 127.0.0.1.\nStatus is read-only. Stop never deletes data or kills an unrelated process.'); return;
  }
  let cmd, app = __dirname, data, port, openBrowser = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (commands.includes(key) && !cmd) cmd = key;
    else if (key === '--app-dir' && args[i + 1]) app = path.resolve(args[++i]);
    else if (key === '--data-dir' && args[i + 1]) data = args[++i];
    else if (key === '--port' && /^\d+$/.test(args[i + 1] || '')) port = Number(args[++i]);
    else if (key === '--open' && !openBrowser) openBrowser = true;
    else { console.error('Invalid options; use --help.'); process.exitCode = 2; return; }
  }
  if (!cmd || port !== undefined && (!Number.isSafeInteger(port) || port < 0 || port > 65535) || data && cmd !== '--configure' || openBrowser && !['--start', '--restart'].includes(cmd)) { console.error('Invalid options; use --help.'); process.exitCode = 2; return; }
  try {
    app = fs.realpathSync.native(app);
    if (cmd === '--configure') { console.log(JSON.stringify(configure(app, data))); return; }
    const cfg = readConfig(app);
    if (cmd === '--status') {
      const live = cfg ? await requestControl(cfg, '/status') : null;
      console.log(JSON.stringify({ configured: !!cfg, running: !!live?.running, ...(live ? { url: live.url, pid: live.pid } : {}) })); return;
    }
    if (!cfg) throw new Error('Run installation configuration before starting this instance');
    if (cmd === '--stop' || cmd === '--restart') {
      const live = await requestControl(cfg, '/stop');
      if (live) {
        const deadline = Date.now() + 35000;
        while (fs.existsSync(path.join(cfg.dataDir, 'runtime.lock'))) {
          if (Date.now() > deadline) throw new Error('Owned runtime has not finished stopping');
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } else if (fs.existsSync(path.join(cfg.dataDir, 'runtime.lock'))) throw new Error('Cannot authenticate the owned runtime; no process was terminated');
      if (cmd === '--stop') { console.log(JSON.stringify({ stopped: true, dataPreserved: true })); return; }
    }
    await start(app, cfg, port, openBrowser);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
if (require.main === module) void main(process.argv.slice(2));
