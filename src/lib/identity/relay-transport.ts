import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IdentityMailTransport, IdentityMessage } from './mail';

interface RelayCredential {
  version: 1;
  installationId: string;
  expiresAt: string;
  relayUrl: string;
  token: string;
}
function credential(): RelayCredential {
  const root = process.env.ACCOUNTEXPRESS_DATA_DIR;
  if (!root || !path.isAbsolute(root) || root.split(/[\\/]/).includes('..')) throw new Error('configuration');
  let ancestor = path.resolve(root);
  for (;;) {
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('configuration');
    const parent = path.dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
  }
  const file = path.join(fs.realpathSync.native(root), 'relay.json');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error('configuration');
  const value = JSON.parse(fs.readFileSync(file, 'utf8')) as RelayCredential;
  if (!value || Object.keys(value).sort().join(',') !== 'expiresAt,installationId,relayUrl,token,version' || value.version !== 1 ||
    typeof value.installationId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(value.installationId) ||
    typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now() ||
    typeof value.token !== 'string' || value.token.length < 16 || value.token.length > 2048) throw new Error('configuration');
  const url = new URL(value.relayUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || url.port || url.username || url.password || url.hash || url.search || !/^\/macros\/s\/[A-Za-z0-9_-]{10,256}\/exec$/.test(url.pathname)) throw new Error('configuration');
  return value;
}
async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error('response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) { await reader.cancel(); throw new Error('response'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export class RelayTransport implements IdentityMailTransport {
  async send(message: IdentityMessage): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = credential();
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), 10000);
      let url = config.relayUrl;
      const body = JSON.stringify({ version: 1, token: config.token, requestId: randomUUID(), language: process.env.ACCOUNTEXPRESS_LANGUAGE === 'en' ? 'en' : 'es', message });
      for (let hop = 0; hop <= 2; hop++) {
        const response = await fetch(url, { method: hop === 0 ? 'POST' : 'GET', ...(hop === 0 ? { headers: { 'Content-Type': 'application/json' }, body } : {}), redirect: 'manual', signal: controller.signal });
        if (response.status === 200) {
          const result = await boundedJson(response) as { ok?: boolean; code?: string };
          if (result?.ok === true && result.code === 'accepted') return;
          throw new Error('rejected');
        }
        if (![302, 303].includes(response.status) || hop === 2) throw new Error('redirect');
        const location = response.headers.get('location');
        if (!location) throw new Error('redirect');
        const target = new URL(location, url);
        if (target.protocol !== 'https:' || target.hostname !== 'script.googleusercontent.com' || target.username || target.password || target.port || target.hash || target.pathname !== '/macros/echo') throw new Error('redirect');
        await response.body?.cancel();
        url = target.href;
      }
      throw new Error('response');
    } catch {
      // One sanitized failure; never log credentials, codes, recipients or provider errors.
      throw new Error('Relay delivery unavailable');
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
}
