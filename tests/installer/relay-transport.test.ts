import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { RelayTransport } from '@/lib/identity/relay-transport';
let root: string;
const valid = {version:1,installationId:'customer-0001',expiresAt:'2099-01-01T00:00:00.000Z',relayUrl:'https://script.google.com/macros/s/abcdefghijklmnop/exec',token:'per-installation-authorization'};
const message = {type:'verification' as const,to:'test@example.com',code:'492817'};
function credential(change: Record<string,unknown> = {}) { fs.writeFileSync(path.join(root,'relay.json'),JSON.stringify({...valid,...change})); }
beforeEach(()=>{ const base=path.resolve('installer/windows/.checks');fs.mkdirSync(base,{recursive:true});root=fs.mkdtempSync(path.join(base,'relay-test-'));vi.stubEnv('ACCOUNTEXPRESS_DATA_DIR',root);vi.stubGlobal('fetch',vi.fn()); });
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.unstubAllEnvs();fs.rmSync(root,{recursive:true,force:true});});
describe('installed relay public transport',()=>{
  it('missing or expired credentials fail without contacting a provider',async()=>{
    const t=new RelayTransport();await expect(t.send(message)).rejects.toThrow('Relay delivery unavailable');
    credential({expiresAt:'2000-01-01'});await expect(t.send(message)).rejects.toThrow('Relay delivery unavailable');expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['http://script.google.com/macros/s/abcdefghijklmnop/exec','https://user:password@script.google.com/macros/s/abcdefghijklmnop/exec','https://script.google.com:8443/macros/s/abcdefghijklmnop/exec','https://foreign.example/macros/s/abcdefghijklmnop/exec','https://script.google.com/macros/s/abc/exec'])('rejects unsafe credential URL %s without sending',async relayUrl=>{
    credential({relayUrl});await expect(new RelayTransport().send(message)).rejects.toThrow('Relay delivery unavailable');expect(fetch).not.toHaveBeenCalled();
  });
  it('sends exact fixed-message contract and accepts JSON receipt only',async()=>{
    credential();vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ok:true,code:'accepted'})));
    await new RelayTransport().send(message);expect(fetch).toHaveBeenCalledOnce();
    const [url,opts]=vi.mocked(fetch).mock.calls[0];expect(url).toBe(valid.relayUrl);expect(opts?.redirect).toBe('manual');
    expect(JSON.parse(String(opts?.body))).toEqual({version:1,token:valid.token,requestId:expect.any(String),language:'es',message});
  });
  it('HTTP200 logical rejection does not count as mail delivery or trigger retries',async()=>{
    credential();vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ok:false,code:'delivery_failed'})));
    await expect(new RelayTransport().send(message)).rejects.toThrow('Relay delivery unavailable');expect(fetch).toHaveBeenCalledOnce();
  });
  it('Google response redirect uses GET and never forwards body or credential',async()=>{
    credential();vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://script.googleusercontent.com/macros/echo?result=1'}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({ok:true,code:'accepted'})));
    await new RelayTransport().send(message);const [,opts]=vi.mocked(fetch).mock.calls[1];expect(opts?.method).toBe('GET');expect(opts?.body).toBeUndefined();expect(opts?.headers).toBeUndefined();
  });
  it.each(['https://foreign.example/macros/echo','http://script.googleusercontent.com/macros/echo','https://user:pass@script.googleusercontent.com/macros/echo','https://script.googleusercontent.com:8443/macros/echo','https://script.googleusercontent.com/not-echo'])('does not follow unsafe redirect %s',async target=>{
    credential();vi.mocked(fetch).mockResolvedValueOnce(new Response(null,{status:302,headers:{location:target}}));await expect(new RelayTransport().send(message)).rejects.toThrow('Relay delivery unavailable');expect(fetch).toHaveBeenCalledOnce();
  });
  it('response is bounded to8192bytes during streaming',async()=>{
    credential();vi.mocked(fetch).mockResolvedValueOnce(new Response('x'.repeat(8193)));await expect(new RelayTransport().send(message)).rejects.toThrow('Relay delivery unavailable');expect(fetch).toHaveBeenCalledOnce();
  });
  it('aborts after10seconds without retry',async()=>{
    credential();vi.useFakeTimers();vi.mocked(fetch).mockImplementation((_url,opts)=>new Promise((_resolve,reject)=>opts?.signal?.addEventListener('abort',()=>reject(new Error('provider secret error')))));
    const checked=expect(new RelayTransport().send(message)).rejects.toThrow('Relay delivery unavailable');await vi.advanceTimersByTimeAsync(10001);await checked;expect(fetch).toHaveBeenCalledOnce();
  });
});
