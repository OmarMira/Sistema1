// Run directly: node design/instalador/preview.test.cjs
// Public DOM controls only; isolated browser memory, no server or database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '01-wizard.html'), 'utf8');
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }
function preview({ stored = {}, blocked = false, systemDark = false } = {}) {
  const errors = [], network = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error.message));
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'https://preview.invalid/', virtualConsole,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: systemDark });
      window.fetch = (...args) => { network.push(args); throw new Error('Network forbidden'); };
      window.XMLHttpRequest = function () { network.push('XHR'); throw new Error('Network forbidden'); };
      if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage blocked'); } });
      else for (const [key, value] of Object.entries(stored)) window.localStorage.setItem(key, value);
    },
  });
  dom.errors = errors; dom.network = network;
  assert.deepEqual(errors, []);
  return dom;
}
const q = (d, s) => { const n = d.window.document.querySelector(s); assert.ok(n, 'Missing control: ' + s); return n; };
const click = (d, s) => q(d, s).click();
function input(d, s, value) { q(d, s).value = value; q(d, s).dispatchEvent(new d.window.Event('input', { bubbles: true })); }
function change(d, s, value) { q(d, s).value = value; q(d, s).dispatchEvent(new d.window.Event('change', { bubbles: true })); }
const step = d => Number(q(d, '#steps li[aria-current]').dataset.step);
function fiscalReady(d) { input(d, '#fiscal-year', '2026'); change(d, '#fiscal-month', '3'); click(d, '#next'); input(d, '#admin-name', 'Demo Admin'); }
function dataReady(d) { click(d, '#next'); input(d, '#business-name', 'Demo Shop'); click(d, '#prepare'); click(d, '#next'); fiscalReady(d); }
function verified(d) { dataReady(d); input(d, '#email', 'demo@example.com'); click(d, '#send'); input(d, '#code', '123456'); click(d, '#verify'); }
function close(d) { assert.deepEqual(d.errors, []); assert.deepEqual(d.network, []); assert.equal(d.window.location.href, 'https://preview.invalid/'); d.window.close(); }

check('artwork: embeds the original landing image byte-for-byte, not a screenshot copy', () => {
  const crypto = require('node:crypto');
  const image = html.match(/background-image:\s*url\(["']?data:image\/(jpeg|png|webp);base64,([^"')]+)/);
  assert.ok(image, 'Background must be embedded for offline use');
  const original = fs.readFileSync(path.join(__dirname, '../../public/hero-dashboard.png'));
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(Buffer.from(image[2], 'base64')), hash(original), 'Background must reuse the original landing asset without cropping or re-encoding');
  // The existing .png-named landing asset actually contains JPEG bytes.
  assert.equal(original.readUInt16BE(0), 0xffd8);
  assert.equal(image[1], 'jpeg', 'Use the actual image format, not the filename extension');
});

check('journey: all five steps, review, completion and restart', () => {
  const d = preview(); assert.equal(step(d), 0); assert.equal(q(d, '#back').disabled, true);
  verified(d); assert.equal(step(d), 3); click(d, '#next'); assert.equal(step(d), 4);
  assert.match(q(d, '#content').textContent, /Demo Shop/); assert.match(q(d, '#content').textContent, /demo@example.com/);
  click(d, '#next'); assert.ok(q(d, '#completion')); click(d, '#restart');
  assert.equal(step(d), 0); click(d, '#next'); assert.equal(q(d, '#business-name').value, ''); close(d);
});
check('data: invalid input and existing data cannot be silently skipped or overwritten', () => {
  const d = preview(); click(d, '#next'); click(d, '#prepare'); assert.equal(step(d), 1);
  assert.equal(q(d, '#business-name').getAttribute('aria-invalid'), 'true'); assert.equal(q(d, '#next').disabled, true);
  input(d, '#business-name', 'My Demo'); change(d, '#data-scenario', 'existing'); click(d, '#prepare');
  assert.equal(q(d, '#next').disabled, true); assert.match(q(d, '#feedback').textContent, /no se borra/i);
  click(d, '#new-space'); assert.equal(q(d, '#business-name').value, 'My Demo'); assert.equal(q(d, '#next').disabled, false); close(d);
});
check('data: simulated failure retries without losing typed business name', () => {
  const d = preview(); click(d, '#next'); input(d, '#business-name', 'Retry Demo'); change(d, '#data-scenario', 'error'); click(d, '#prepare');
  assert.equal(q(d, '#next').disabled, true); click(d, '#retry-data'); assert.equal(q(d, '#business-name').value, 'Retry Demo');
  assert.equal(q(d, '#next').disabled, false); close(d);
});
check('email: malformed address, send failure, retry, wrong code and verified code', () => {
  const d = preview(); dataReady(d); input(d, '#email', 'bad'); click(d, '#send');
  assert.equal(q(d, '#email').getAttribute('aria-invalid'), 'true'); assert.equal(q(d, '#next').disabled, true);
  input(d, '#email', 'demo@example.com'); change(d, '#email-scenario', 'error'); click(d, '#send');
  assert.equal(q(d, '#next').disabled, true); click(d, '#retry-email'); assert.equal(q(d, '#email').value, 'demo@example.com');
  input(d, '#code', '000000'); click(d, '#verify'); assert.equal(q(d, '#next').disabled, true);
  assert.equal(q(d, '#code').getAttribute('aria-invalid'), 'true'); input(d, '#code', '123456'); click(d, '#verify');
  assert.equal(q(d, '#next').disabled, false); close(d);
});
check('back preserves inputs; changed email and company require a fresh check', () => {
  const d = preview(); verified(d); click(d, '#next'); click(d, '#back'); assert.equal(q(d, '#email').value, 'demo@example.com');
  input(d, '#email', 'other@example.com'); assert.equal(q(d, '#next').disabled, true); click(d, '#send');
  input(d, '#code', '123456'); click(d, '#verify'); click(d, '#back'); click(d, '#back'); assert.equal(q(d, '#business-name').value, 'Demo Shop');
  input(d, '#business-name', 'Changed'); assert.equal(q(d, '#next').disabled, true); close(d);
});
check('theme and language remain independent and translate errors without losing input', () => {
  const d = preview(); click(d, '#theme-toggle'); assert.equal(d.window.document.documentElement.classList.contains('dark'), true);
  assert.equal(q(d, '#theme-icon').getAttribute('href'), '#sun'); click(d, '#next'); input(d, '#business-name', 'Keep Me');
  change(d, '#data-scenario', 'error'); click(d, '#prepare'); change(d, '#language-select', 'en');
  assert.equal(q(d, '#business-name').value, 'Keep Me'); assert.equal(d.window.document.documentElement.lang, 'en');
  assert.match(q(d, '#feedback').textContent, /could not prepare/i); assert.equal(q(d, '#theme-toggle').getAttribute('aria-label'), 'Switch to light mode');
  click(d, '#retry-data'); click(d, '#next'); fiscalReady(d); input(d, '#email', 'demo@example.com'); click(d, '#send'); input(d, '#code', '123456'); click(d, '#verify'); click(d, '#next');
  assert.match(q(d, '#content').textContent, /Keep Me/); assert.match(q(d, '#content').textContent, /Simulated/);
  assert.ok(!d.window.document.body.textContent.includes('undefined')); click(d, '#theme-toggle'); assert.equal(d.window.document.documentElement.classList.contains('dark'), false); close(d);
});
check('stored preferences restore and unavailable storage does not block the journey', () => {
  const d = preview({ systemDark: true, stored: { 'ae-installer-preview.theme': 'light', 'ae-installer-preview.language': 'en' } });
  assert.equal(d.window.document.documentElement.lang, 'en'); assert.equal(d.window.document.documentElement.classList.contains('dark'), false); close(d);
  const b = preview({ blocked: true }); verified(b); click(b, '#next'); click(b, '#next'); assert.ok(q(b, '#completion')); close(b);
});
check('user-entered text remains text; only theme/language are persisted', () => {
  const d = preview(); click(d, '#next'); input(d, '#business-name', '<img src=x onerror=alert(1)>'); click(d, '#prepare'); click(d, '#next'); fiscalReady(d);
  input(d, '#email', 'demo@example.com'); click(d, '#send'); input(d, '#code', '123456'); click(d, '#verify'); click(d, '#next');
  assert.equal(d.window.document.querySelectorAll('img').length, 0); assert.match(q(d, '#content').textContent, /<img src=x/);
  assert.equal(d.window.localStorage.length, 0); assert.equal(d.window.document.querySelectorAll('script[src],link[href],form').length, 0); close(d);
});
check('typing keeps the original focused input and native caret/selection for every field', () => {
  const d = preview(); dataReady(d);
  const email = q(d, '#email'); email.focus();
  let address = '';
  for (const letter of 'demo@example.com') {
    address += letter;
    email.value = address;
    email.dispatchEvent(new d.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: letter }));
    assert.equal(q(d, '#email'), email, 'Typing must not replace the email input');
    assert.equal(d.window.document.activeElement, email, 'Email focus must not reset');
    assert.equal(email.value, address);
  }
  click(d, '#send');
  const code = q(d, '#code'); code.focus();
  for (const digit of '123456') {
    code.setRangeText(digit, code.selectionStart, code.selectionEnd, 'end');
    const caret = code.selectionStart;
    code.dispatchEvent(new d.window.InputEvent('input', { bubbles: true, inputType: 'insertText', data: digit }));
    assert.equal(q(d, '#code'), code);
    assert.equal(d.window.document.activeElement, code);
    assert.equal(code.selectionStart, caret);
  }
  assert.equal(code.value, '123456'); click(d, '#verify'); click(d, '#back'); click(d, '#back');
  const business = q(d, '#business-name'); business.focus();
  business.setSelectionRange(0, 4, 'backward');
  business.dispatchEvent(new d.window.InputEvent('input', { bubbles: true, inputType: 'insertCompositionText', data: 'Demo', isComposing: true }));
  assert.equal(q(d, '#business-name'), business);
  assert.equal(d.window.document.activeElement, business);
  assert.equal(business.selectionStart, 0); assert.equal(business.selectionEnd, 4);
  assert.equal(business.selectionDirection, 'backward');
  business.setRangeText('My', 0, 4, 'end');
  business.dispatchEvent(new d.window.InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: 'My' }));
  assert.equal(business.value, 'My Shop'); assert.equal(business.selectionStart, 2);
  assert.equal(q(d, '#next').disabled, true);
  click(d, '#prepare'); click(d, '#next'); click(d, '#next'); assert.equal(q(d, '#email').value, 'demo@example.com'); close(d);
});
check('company currency is retained, reviewed and invalidates preparation when changed', () => {
  const d = preview(); dataReady(d); click(d, '#back'); click(d, '#back');
  assert.deepEqual(Array.from(q(d, '#currency').options, o => o.value), ['USD', 'EUR', 'MXN', 'ARS', 'GBP']);
  change(d, '#currency', 'EUR'); assert.equal(q(d, '#next').disabled, true);
  click(d, '#prepare'); click(d, '#next'); click(d, '#next');
  input(d, '#email', 'demo@example.com'); click(d, '#send'); input(d, '#code', '123456'); click(d, '#verify'); click(d, '#next');
  assert.match(q(d, '#content').textContent, /EUR/); assert.match(q(d, '#content').textContent, /2026/);
  assert.match(q(d, '#content').textContent, /marzo/i);
  click(d, '#next'); click(d, '#restart'); click(d, '#next'); assert.equal(q(d, '#currency').value, 'USD');
  input(d, '#business-name', 'Restart'); click(d, '#prepare'); click(d, '#next');
  assert.equal(q(d, '#fiscal-year').value, ''); assert.equal(q(d, '#fiscal-month').value, ''); close(d);
});
check('fiscal year/month validation gates progress and preserves native typing, choices and translations', () => {
  const d = preview(); click(d, '#next'); input(d, '#business-name', 'Fiscal Demo'); click(d, '#prepare'); click(d, '#next');
  const year = q(d, '#fiscal-year'); year.focus();
  for (const digit of '2026') {
    year.setRangeText(digit, year.selectionStart, year.selectionEnd, 'end');
    year.dispatchEvent(new d.window.InputEvent('input', { bubbles: true, data: digit }));
    assert.equal(q(d, '#fiscal-year'), year); assert.equal(d.window.document.activeElement, year);
    assert.equal(year.selectionStart, year.value.length);
  }
  for (const bad of ['', '1999', '2101', '2026.5', 'abcd']) {
    input(d, '#fiscal-year', bad); click(d, '#next'); assert.equal(step(d), 2);
    assert.equal(q(d, '#fiscal-year').getAttribute('aria-invalid'), 'true');
  }
  input(d, '#fiscal-year', '2000'); click(d, '#next'); assert.equal(step(d), 2);
  assert.equal(q(d, '#fiscal-month').getAttribute('aria-invalid'), 'true');
  change(d, '#fiscal-month', '1'); change(d, '#period-type', 'CUSTOM_MONTHS');
  change(d, '#language-select', 'en'); assert.equal(q(d, '#fiscal-year').value, '2000');
  assert.equal(q(d, '#fiscal-month').value, '1'); assert.equal(q(d, '#period-type').value, 'CUSTOM_MONTHS');
  assert.match(q(d, '#bank-balances').textContent, /each bank account/); click(d, '#next'); assert.equal(step(d), 3);
  click(d, '#back'); input(d, '#fiscal-year', '2100'); change(d, '#fiscal-month', '12'); change(d, '#period-type', 'WEEK_52_53');
  click(d, '#theme-toggle'); assert.equal(q(d, '#fiscal-year').value, '2100');
  click(d, '#next'); input(d, '#admin-name', 'Demo Admin'); input(d, '#email', 'demo@example.com'); click(d, '#send'); input(d, '#code', '123456'); click(d, '#verify'); click(d, '#next');
  assert.match(q(d, '#content').textContent, /2100/); assert.match(q(d, '#content').textContent, /December/);
  assert.match(q(d, '#content').textContent, /52\/53/); assert.equal(d.window.document.querySelectorAll('input').length, 0);
  assert.equal(d.window.localStorage.length, 2); close(d);
});
check('no opening balance field exists and bank import guidance is visible in both languages', () => {
  for (const language of ['es', 'en']) {
    const d = preview({ stored: { 'ae-installer-preview.language': language } });
    dataReady(d); click(d, '#back');
    assert.ok(!Array.from(d.window.document.querySelectorAll('input')).some(n => /balance|saldo/i.test(n.id)));
    assert.match(q(d, '#bank-balances').textContent, language === 'es' ? /cada cuenta bancaria/ : /each bank account/);
    assert.match(q(d, '#bank-balances').textContent, language === 'es' ? /no incluye|no puede leerse/ : /does not include|cannot be read/);
    close(d);
  }
});
check('initial administrator name is required, keeps typing intact, and is reviewed with email and simulated role', () => {
  for (const language of ['es', 'en']) {
    const d = preview({ stored: { 'ae-installer-preview.language': language } }); dataReady(d);
    input(d, '#admin-name', '   '); input(d, '#email', 'demo@example.com'); click(d, '#send');
    assert.equal(q(d, '#admin-name').getAttribute('aria-invalid'), 'true');
    assert.equal(q(d, '#next').disabled, true); assert.equal(d.window.document.querySelector('#code'), null);
    const name = q(d, '#admin-name'); name.focus(); name.value = '';
    for (const letter of 'Ana Demo') {
      name.setRangeText(letter, name.selectionStart, name.selectionEnd, 'end');
      name.dispatchEvent(new d.window.InputEvent('input', { bubbles: true, data: letter }));
      assert.equal(q(d, '#admin-name'), name); assert.equal(d.window.document.activeElement, name);
      assert.equal(name.selectionStart, name.value.length);
    }
    click(d, '#send'); input(d, '#admin-name', 'Ana Demo Updated'); assert.ok(q(d, '#code'));
    input(d, '#code', '123456'); click(d, '#verify');
    input(d, '#admin-name', ''); assert.equal(q(d, '#next').disabled, true);
    input(d, '#admin-name', 'Ana <Demo>'); assert.equal(q(d, '#next').disabled, false);
    click(d, '#next'); assert.match(q(d, '#content').textContent, /Ana <Demo>/);
    assert.match(q(d, '#content').textContent, /demo@example.com/);
    assert.match(q(d, '#content').textContent, language === 'es' ? /Superadministrador inicial · Simulado/ : /Initial super administrator · Simulated/);
    click(d, '#back'); assert.equal(q(d, '#admin-name').value, 'Ana <Demo>');
    change(d, '#language-select', language === 'es' ? 'en' : 'es'); assert.equal(q(d, '#admin-name').value, 'Ana <Demo>');
    click(d, '#next'); click(d, '#next'); click(d, '#restart');
    click(d, '#next'); input(d, '#business-name', 'Restart'); click(d, '#prepare'); click(d, '#next');
    input(d, '#fiscal-year', '2026'); change(d, '#fiscal-month', '1'); click(d, '#next');
    assert.equal(q(d, '#admin-name').value, ''); assert.equal(q(d, '#email').value, '');
    assert.equal(d.window.localStorage.getItem('ae-installer-preview.adminName'), null); close(d);
  }
});
console.log('RESULT: ' + passed + ' checks passed; no network or database operations.');
