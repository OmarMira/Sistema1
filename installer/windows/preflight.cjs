#!/usr/bin/env node
'use strict';
// Preflight only: never creates installation/data directories or overwrites their contents.
const fs = require('node:fs');
const path = require('node:path').win32;
const { randomUUID } = require('node:crypto');
const help = `AccountExpress Windows installation preflight

node preflight.cjs --program-dir <absolute-local-folder> --data-dir <separate-local-folder>
  --program-bytes <positive-integer> --data-bytes <positive-integer>

Sizes must include payload/staging requirements and initial data reserve.
Checks paths, existing contents, filesystem links, free space and write permission.
Only a uniquely named temporary permission-probe folder/file is created and removed.
No installation, database initialization, elevation or registry changes occur.
Output: one JSON line. Exit 0=ready, 1=not ready, 2=invalid command options.
This check is not an install/overwrite authorization; recheck before actual writes.
`;
class CheckError extends Error { constructor(code) { super(code); this.code = code; } }
const inside = (child, parent) => child.toLowerCase() === parent.toLowerCase() || child.toLowerCase().startsWith(parent.toLowerCase().replace(/\\+$/, '') + '\\');
function localPath(input) {
  if (typeof input !== 'string' || !/^[A-Za-z]:[\\/]/.test(input) || /[\x00-\x1f\x7f]/.test(input)) throw new CheckError('invalid_path');
  const parts = input.slice(3).split(/[\\/]/).filter(Boolean);
  if (!parts.length || parts.some(part => part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(part))) throw new CheckError('invalid_path');
  const result = path.normalize(input);
  const system = path.normalize(process.env.SystemRoot || 'C:\\Windows');
  if (inside(result, system)) throw new CheckError('invalid_path');
  return result.replace(/\\+$/, '');
}
function inspect(input, role) {
  const selected = localPath(input), parsed = path.parse(selected);
  let existing = parsed.root, remainder = [];
  const parts = selected.slice(parsed.root.length).split('\\');
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(existing, parts[i]);
    let stat;
    try { stat = fs.lstatSync(next); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      remainder = parts.slice(i); break;
    }
    if (stat.isSymbolicLink()) throw new CheckError('unsafe_link');
    if (!stat.isDirectory()) throw new CheckError('not_directory');
    existing = next;
  }
  const ancestor = fs.realpathSync.native(existing);
  const resolved = localPath(path.join(ancestor, ...remainder));
  if (!remainder.length) {
    const entries = fs.readdirSync(resolved);
    if (role === 'program' && entries.includes('.accountexpress-install.json')) throw new CheckError('already_installed');
    if (entries.length) throw new CheckError(role === 'program' ? 'destination_not_empty' : 'existing_data');
  }
  return { selected: resolved, ancestor };
}
function availableBytes(directory) {
  const space = fs.statfsSync(directory, { bigint: true });
  return space.bavail * space.bsize;
}
function probeWrite(directory) {
  const temporary = path.join(directory, '.accountexpress-preflight-' + randomUUID());
  const file = path.join(temporary, 'write-probe');
  let created = false, opened = false, descriptor;
  try {
    fs.mkdirSync(temporary); created = true;
    descriptor = fs.openSync(file, 'wx', 0o600); opened = true;
    fs.closeSync(descriptor); descriptor = undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (opened) fs.unlinkSync(file);
    // Never recursively delete a directory: preserve anything we did not create.
    if (created) fs.rmdirSync(temporary);
  }
}
function preflight(config, services = {}) {
  try {
    if (process.platform !== 'win32') throw new CheckError('unsupported_platform');
    if (!config || !Number.isSafeInteger(config.requiredProgramBytes) || config.requiredProgramBytes <= 0 || !Number.isSafeInteger(config.requiredDataBytes) || config.requiredDataBytes <= 0) throw new CheckError('invalid_size');
    const program = inspect(config.programDir, 'program'), data = inspect(config.dataDir, 'data');
    if (inside(program.selected, data.selected) || inside(data.selected, program.selected)) throw new CheckError('overlapping_paths');
    const measure = services.availableBytes || availableBytes, probe = services.probeWrite || probeWrite;
    const programFree = measure(program.ancestor), dataFree = measure(data.ancestor);
    if (typeof programFree !== 'bigint' || typeof dataFree !== 'bigint' || programFree < 0n || dataFree < 0n) throw new CheckError('filesystem_unavailable');
    const programRequired = BigInt(config.requiredProgramBytes), dataRequired = BigInt(config.requiredDataBytes);
    const sameVolume = fs.statSync(program.ancestor).dev === fs.statSync(data.ancestor).dev;
    const total = programRequired + dataRequired;
    if (sameVolume ? programFree < total || dataFree < total : programFree < programRequired || dataFree < dataRequired) throw new CheckError('insufficient_space');
    for (const directory of new Set([program.ancestor, data.ancestor])) probe(directory);
    return { ok: true, code: 'ready', programDir: program.selected, dataDir: data.selected, requiredBytes: String(total), availableBytes: String(sameVolume ? (programFree < dataFree ? programFree : dataFree) : programFree + dataFree) };
  } catch (error) {
    const code = error instanceof CheckError ? error.code
      : ['EACCES', 'EPERM'].includes(error.code) ? 'permission_denied'
      : error.code === 'ENOSPC' ? 'insufficient_space'
      : error.code === 'ENOTDIR' ? 'not_directory' : 'filesystem_unavailable';
    return { ok: false, code };
  }
}
function main(args) {
  if (!args.length || args.length === 1 && args[0] === '--help') { process.stdout.write(help); return; }
  const allowed = ['--program-dir', '--data-dir', '--program-bytes', '--data-bytes'];
  const options = Object.create(null);
  for (let i = 0; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options[args[i]]) throw new CheckError('invalid_options');
    options[args[i]] = args[i + 1];
  }
  if (allowed.some(name => !options[name])) throw new CheckError('invalid_options');
  const number = value => /^\d+$/.test(value) ? Number(value) : NaN;
  const result = preflight({ programDir: options['--program-dir'], dataDir: options['--data-dir'], requiredProgramBytes: number(options['--program-bytes']), requiredDataBytes: number(options['--data-bytes']) });
  process.stdout.write(JSON.stringify(result) + '\n');
  process.exitCode = result.ok ? 0 : 1;
}
module.exports = { preflight };
if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch { process.stderr.write('Invalid options; use --help.\n'); process.exitCode = 2; }
}
