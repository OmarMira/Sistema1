'use strict';
// Real layout checks using the installed Edge, with no browser-library dependency.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function journey(language, dark) {
  const $ = selector => { const node = document.querySelector(selector); if (!node) throw Error('Missing ' + selector); return node; };
  const click = selector => $(selector).click();
  const set = (selector, value, event = 'input') => { $(selector).value = value; $(selector).dispatchEvent(new Event(event, { bubbles: true })); };
  set('#language-select', language, 'change');
  if (document.documentElement.classList.contains('dark') !== dark) click('#theme-toggle');
  const art = $('#installer-art');
  if (art.getAttribute('aria-hidden') !== 'true' || getComputedStyle(art).pointerEvents !== 'none') throw Error('Artwork must be decorative and non-interactive');
  const layer = getComputedStyle(art, '::before');
  const embedded = layer.backgroundImage.match(/url\(["']?(data:image\/jpeg;base64,[^"')]+)["']?\)/);
  if (!embedded || !/blur\([1-9]/.test(layer.filter)) throw Error('Artwork must be embedded and blurred on its own layer');
  const artwork = new Image(); artwork.src = embedded[1]; await artwork.decode();
  if (!artwork.naturalWidth || !artwork.naturalHeight) throw Error('Background image did not decode');
  for (const selector of ['.card', '#content', '.step-guide', '.step-form', 'h1', 'h2', '.actions']) {
    if (getComputedStyle($(selector)).filter !== 'none') throw Error('Text and controls must remain unblurred: ' + selector);
  }
  // Worst-case black/white image pixels bound contrast even after decorative blur.
  const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
  const luminance = color => color.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
  const base = rgb(getComputedStyle($('.card')).backgroundColor), alpha = Number(layer.opacity);
  for (const selector of ['.step-guide', '.step-guide h2', '.help']) {
    const color = rgb(getComputedStyle($(selector)).color), foreground = luminance(color);
    for (const extreme of [0, 255]) {
      const background = luminance(base.map(v => v * (1 - alpha) + extreme * alpha));
      const ratio = (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      if (ratio < 4.5) throw Error('Background reduces text contrast below 4.5: ' + selector + ' (' + ratio.toFixed(2) + ')');
    }
  }
  const states = [];
  function check(label) {
    const root = document.scrollingElement;
    const failures = [];
    if (root.scrollHeight > innerHeight + 1 || root.scrollWidth > innerWidth + 1) failures.push('document ' + root.scrollWidth + 'x' + root.scrollHeight);
    for (const node of document.querySelectorAll('button,input,select,p,h1,h2,label,dt,dd,summary,footer')) {
      const rect = node.getBoundingClientRect();
      if (!rect.width || !rect.height || !node.checkVisibility()) continue;
      if (rect.top < -1 || rect.left < -1 || rect.bottom > innerHeight + 1 || rect.right > innerWidth + 1) failures.push((node.id || node.tagName) + ' outside viewport');
    }
    for (const node of document.querySelectorAll('.card,#content,.step-form,.step-guide')) {
      const css = getComputedStyle(node);
      if (['hidden', 'clip', 'scroll', 'auto'].includes(css.overflowY) && node.scrollHeight > node.clientHeight + 1) failures.push('clipped/scrolled ' + (node.id || node.className));
    }
    states.push({ label, failures });
  }
  check('welcome'); click('#next'); check('company');
  click('#prepare'); check('company-invalid');
  set('#business-name', 'Tienda de demostración');
  $('#data-scenario').closest('details').open = true; check('company-scenarios-open');
  set('#data-scenario', 'error', 'change'); click('#prepare'); check('company-failure');
  click('#retry-data'); check('company-ready');
  set('#data-scenario', 'existing', 'change'); click('#prepare'); check('existing-data');
  click('#new-space'); click('#next'); check('fiscal');
  click('#next'); check('year-invalid'); set('#fiscal-year', '2026'); click('#next'); check('month-invalid');
  set('#fiscal-month', '3', 'change'); click('#next'); check('administrator');
  click('#send'); check('name-invalid'); set('#admin-name', 'Persona de demostración');
  set('#email', 'bad'); click('#send'); check('email-invalid'); set('#email', 'demo@example.com');
  $('#email-scenario').closest('details').open = true; check('email-scenarios-open');
  set('#email-scenario', 'error', 'change'); click('#send'); check('email-failure');
  click('#retry-email'); check('code'); set('#code', '000000'); click('#verify'); check('code-invalid');
  set('#code', '123456'); click('#verify'); check('verified'); click('#next'); check('review');
  click('#next'); check('completion');
  return states;
}

(async () => {
  const browserPath = process.env.BROWSER_BIN || path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe');
  const profile = fs.mkdtempSync(path.join(__dirname, '.layout-browser-'));
  let browser, socket;
  const pending = new Map(); let sequence = 0;
  const watchdog = setTimeout(() => { console.error('FAIL browser check timed out'); browser?.kill(); process.exitCode = 124; }, 75000);
  try {
    browser = spawn(browserPath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const endpoint = await new Promise((resolve, reject) => {
      browser.once('error', reject); browser.once('exit', code => reject(Error('Browser exited: ' + code)));
      let output = '';
      browser.stderr.on('data', data => { output += data; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) resolve(match[1]); });
    });
    socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    socket.addEventListener('message', event => { const message = JSON.parse(event.data); const task = pending.get(message.id); if (task) { pending.delete(message.id); message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result); } });
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const failures = []; let snapshots = 0;
    for (const [width, height] of [[1366, 768], [1280, 720], [1024, 768], [1366, 640], [1024, 640]]) {
      for (const language of ['es', 'en']) for (const dark of [false, true]) {
        const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
        const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
        await send('Page.enable', {}, sessionId);
        await send('Network.enable', {}, sessionId);
        await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }, sessionId);
        // Read the standalone artifact into an isolated about:blank page; no server or app state.
        await send('Runtime.evaluate', { expression: 'document.open();document.write(' + JSON.stringify(fs.readFileSync(path.join(__dirname, '01-wizard.html'), 'utf8')) + ');document.close();' }, sessionId);
        const result = await send('Runtime.evaluate', { expression: '(' + journey.toString() + ')(' + JSON.stringify(language) + ',' + dark + ')', awaitPromise: true, returnByValue: true }, sessionId);
        if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
        for (const state of result.result.value) { snapshots++; if (state.failures.length) failures.push({ viewport: width + 'x' + height, language, theme: dark ? 'dark' : 'light', ...state }); }
        if (process.env.CAPTURE_PREVIEW === '1' && width === 1366 && height === 768 && language === 'es') {
          await send('Runtime.evaluate', { expression: 'document.getElementById("restart").click()' }, sessionId);
          const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
          const directory = path.join(__dirname, '.screenshots'); fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(path.join(directory, 'background-' + (dark ? 'dark' : 'light') + '.png'), Buffer.from(data, 'base64'));
        }
        await send('Target.closeTarget', { targetId });
      }
    }
    console.log(JSON.stringify({ snapshots, failedStates: failures.length, failures: failures.slice(0, 6) }, null, 2));
    assert.equal(failures.length, 0, 'Every step/error must fit without scrolling or clipping');
    console.log('PASS real-browser layout: ' + snapshots + ' states fit; no document/panel scrolling or clipped controls.');
    await send('Browser.close').catch(() => {});
  } finally {
    clearTimeout(watchdog); socket?.close();
    if (browser && browser.exitCode === null) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await exited; }
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { console.error('Temporary browser profile could not be removed: ' + profile); }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
