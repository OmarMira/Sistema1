#!/usr/bin/env node
'use strict';
// Operator-only tool. Never include this tool or its signing key in a client installer.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const help = `AccountExpress mail-relay operator tool (Node.js)

Initialize a private signing key, once:
  node owner.cjs init --output <private-signing-key-file>

Issue one installation credential:
  node owner.cjs issue --key-file <private-signing-key-file>
    --installation-id <unique-id> --expires <YYYY-MM-DD>
    --relay-url <https://script.google.com/macros/s/DEPLOYMENT/exec>
    --output <installation-credential.json>

Existing output files are never overwritten. No key or token is printed.
Copy the private signing key ONLY to the owner's Google Script Properties.
Distribute only the corresponding installation credential, never the signing key.
Daily limits are enforced by the relay, not configurable by the customer.
`;
function options(args, allowed) {
  const result = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || result[args[i]]) throw Error('Invalid options; use --help.');
    result[args[i]] = args[i + 1];
  }
  if (allowed.some(name => !result[name])) throw Error('Missing required option; use --help.');
  return result;
}
function writeNew(file, value) {
  // Caller chooses an existing private directory; do not create broad-access parent folders.
  fs.writeFileSync(path.resolve(file), value, { flag: 'wx', mode: 0o600 });
}
function main(args) {
  if (!args.length || args[0] === '--help') { process.stdout.write(help); return; }
  if (args[0] === 'init') {
    const option = options(args.slice(1), ['--output']);
    writeNew(option['--output'], crypto.randomBytes(32).toString('hex') + '\n');
    process.stdout.write('Private signing key created. Do not distribute it.\n');
    return;
  }
  if (args[0] !== 'issue') throw Error('Unknown command; use --help.');
  const option = options(args.slice(1), ['--key-file', '--installation-id', '--expires', '--relay-url', '--output']);
  const id = option['--installation-id'];
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw Error('Installation ID must contain 8–80 letters, digits, underscores or hyphens.');
  const date = option['--expires'];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('Expiration must be YYYY-MM-DD.');
  const expiration = Date.parse(date + 'T00:00:00Z');
  if (!Number.isFinite(expiration) || new Date(expiration).toISOString().slice(0, 10) !== date || expiration <= Date.now()) throw Error('Expiration must be a real future UTC date.');
  const url = new URL(option['--relay-url']);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || url.port || url.username || url.password || url.search || url.hash || !/^\/macros\/s\/[A-Za-z0-9_-]{10,256}\/exec$/.test(url.pathname)) throw Error('Use the published Google Apps Script /exec HTTPS URL.');
  const key = fs.readFileSync(path.resolve(option['--key-file']), 'utf8').trim();
  if (!/^[0-9a-f]{64}$/i.test(key)) throw Error('Invalid signing key file.');
  const claims = { id, exp: Math.floor(expiration / 1000) };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token = payload + '.' + crypto.createHmac('sha256', key).update(payload).digest('base64url');
  const credential = { version: 1, installationId: id, expiresAt: new Date(expiration).toISOString(), relayUrl: url.href, token };
  writeNew(option['--output'], JSON.stringify(credential, null, 2) + '\n');
  process.stdout.write('Installation credential created. The signing key was not copied.\n');
}
try { main(process.argv.slice(2)); }
catch (error) {
  // Filesystem paths and upstream error payloads may contain sensitive data.
  const known = error instanceof Error && !error.code && !(error instanceof TypeError);
  process.stderr.write(known ? error.message + '\n' : 'Operation failed; verify options, private file access and that output does not already exist.\n');
  process.exitCode = 1;
}
