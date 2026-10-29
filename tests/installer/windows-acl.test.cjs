'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const base = path.resolve('installer/windows/.checks'); fs.mkdirSync(base, {recursive:true});
function principals(target) {
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command', "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:ACL_TARGET; $a.Access | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value}"],{encoding:'utf8',timeout:10000,env:{...process.env,ACL_TARGET:target}});
  assert.equal(result.status,0,result.stderr); assert.equal(result.stderr,'');
  const sids=result.stdout.trim().split(/\r?\n/);assert.ok(sids.includes('S-1-5-18'),'ACL probe must actually enumerate SYSTEM');return sids;
}
test('configure removes unrelated explicit grants before writing installation secrets', () => {
  const root=fs.mkdtempSync(path.join(base,'acl-test-'));
  const app=path.join(root,'app'),data=path.join(root,'data'); fs.mkdirSync(app); fs.mkdirSync(data);
  try {
    const grant=spawnSync('icacls.exe',[data,'/grant','*S-1-1-0:(OI)(CI)F'],{encoding:'utf8',timeout:10000});
    assert.equal(grant.status,0,grant.stderr); assert.ok(principals(data).includes('S-1-1-0'),'Fixture must start with explicit Everyone access');
    const configured=spawnSync(process.execPath,[path.resolve('installer/windows/launcher.cjs'),'--configure','--app-dir',app,'--data-dir',data],{encoding:'utf8',timeout:15000});
    assert.equal(configured.status,0,configured.stderr);
    assert.equal(principals(data).includes('S-1-1-0'),false,'Everyone must not retain read/write access to private instance secrets');
    assert.equal(principals(path.join(data,'instance.json')).includes('S-1-1-0'),false);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
