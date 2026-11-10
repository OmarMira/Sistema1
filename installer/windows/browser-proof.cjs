'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { environment } = require('./runtime.cjs');
async function browserProof(url, work, options = {}) {
  const browserPath = path.join(__dirname, '.cache/browsers');
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
  const { chromium } = require('./.checks/browser-tools/node_modules/playwright');
  const profile = path.join(work, 'browser-profile');
  const temporary = path.join(work, 'browser-temp'); fs.mkdirSync(temporary);
  const context = await chromium.launchPersistentContext(profile, { headless: true, env: environment({ PLAYWRIGHT_BROWSERS_PATH: browserPath, TEMP: temporary, TMP: temporary }), args: ['--disable-background-networking', '--disable-component-update', '--disable-sync'] });
  const states = []; const failures = [];
  try {
    // Only the installed app is reachable. Google mail is never contacted by this browser proof.
    await context.route('**/*', route => new URL(route.request().url()).origin === new URL(url).origin ? route.continue() : route.abort());
    for (const [width, height] of options.viewports || [[1366,768],[1280,720],[1024,768],[1366,640],[1024,640]]) for (const language of options.languages || ['es','en']) for (const dark of options.themes || [false,true]) {
      const page = await context.newPage(); await page.setViewportSize({width,height});
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.addInitScript(lang => localStorage.setItem('accountexpress-language',JSON.stringify({state:{language:lang},version:0})), language);
      await page.goto(url, { waitUntil: 'networkidle' });
      await page.getByRole('button',{name:/Registrarse|Register|Sign Up|Create Account/i}).click();
      await page.getByRole('heading',{name:language==='es'?'Asistente de instalación':'Installation assistant'}).waitFor();
      if (await page.locator('html').evaluate(element=>element.classList.contains('dark')) !== dark) await page.getByRole('button',{name:/Switch to .* mode/}).click();
      const check = async label => {
        const result = await page.evaluate(() => {
          const issues = []; const root=document.scrollingElement;
          const form=document.querySelector('form');
          if(form){
            const artwork=getComputedStyle(form,'::before');
            if(!artwork.filter.includes('blur(4px)')||!artwork.filter.includes('saturate(0.8)'))issues.push('approved decorative blur/saturation missing');
            if(artwork.clipPath==='none')issues.push('decorative blur not clipped independently');
          }
          const passwords=[...document.querySelectorAll('input[autocomplete="new-password"]')];
          if(passwords.length===2){
            if(innerWidth>800&&Math.abs(passwords[0].getBoundingClientRect().top-passwords[1].getBoundingClientRect().top)>1)issues.push('password and confirmation on different desktop rows');
            for(const input of passwords)if(!input.id||!document.querySelector('button[aria-controls="'+input.id+'"]'))issues.push('password reveal control missing');
          }
          if(root.scrollWidth>innerWidth+1 || root.scrollHeight>innerHeight+1)issues.push('document '+root.scrollWidth+'x'+root.scrollHeight);
          for(const element of document.querySelectorAll('button,input,select,p,h1,h2,label,dt,dd,footer')) {
            const rect=element.getBoundingClientRect(); if(!rect.width||!rect.height||!element.checkVisibility())continue;
            if(rect.left < -1 || rect.top < -1 || rect.right > innerWidth+1 || rect.bottom > innerHeight+1)issues.push((element.tagName+':'+element.textContent).slice(0,80)+' outside viewport');
            if(getComputedStyle(element).filter!=='none')issues.push('blurred text/control');
          }
          return issues;
        });
        states.push({width,height,language,dark,label}); if(result.length)failures.push({width,height,language,dark,label,issues:result});
      };
      await check('welcome');
      await page.getByRole('button',{name:language==='es'?'Comenzar':'Start',exact:true}).click(); await check('company');
      await page.getByLabel(language==='es'?'Nombre legal de tu empresa':'Company legal name').fill('Isolated Browser Company');
      await page.getByRole('button',{name:language==='es'?'Continuar':'Continue',exact:true}).click(); await check('fiscal');
      await page.getByRole('button',{name:language==='es'?'Continuar':'Continue',exact:true}).click(); await check('administrator');
      for(const [es,en,value] of [['Nombre','First name','Ana'],['Apellido','Last name','Proof'],['Correo electrónico','Email address','browser-proof@example.invalid'],['Contraseña','Password','BrowserProof123!'],['Confirmar contraseña','Confirm password','BrowserProof123!']]) await page.getByLabel(language==='es'?es:en,{exact:true}).fill(value);
      for(const [es,en,esHide,enHide,label] of [['Mostrar contraseña','Show password','Ocultar contraseña','Hide password',language==='es'?'Contraseña':'Password'],['Mostrar confirmación de contraseña','Show password confirmation','Ocultar confirmación de contraseña','Hide password confirmation',language==='es'?'Confirmar contraseña':'Confirm password']]) {
        const toggle=page.getByRole('button',{name:language==='es'?es:en,exact:true});
        if(await toggle.count()) {
          const input=page.getByLabel(label,{exact:true});const original=await input.inputValue();
          await toggle.click();assert.equal(await input.getAttribute('type'),'text');
          await page.getByRole('button',{name:language==='es'?esHide:enHide,exact:true}).click();
          assert.equal(await input.getAttribute('type'),'password');assert.equal(await input.inputValue(),original);
        }
      }
      if(width===1366&&height===768&&language==='es')await page.screenshot({path:path.join(work,'passwords-'+(dark?'dark':'light')+'.png'),fullPage:true});
      await page.getByRole('button',{name:language==='es'?'Revisar':'Review',exact:true}).click(); await check('review');
      // Geometry of accepted-mail/code input uses a stub receipt; not a live-delivery claim.
      await page.route('**/api/auth/register',route=>route.fulfill({json:{requiresVerification:true,deliveryFailed:false}}));
      await page.getByRole('button',{name:language==='es'?'Enviar código':'Send code',exact:true}).click();
      await page.getByLabel(language==='es'?'Código de verificación':'Verification code').waitFor(); await check('code');
      if(width===1366 && height===768 && language==='es')await page.screenshot({path:path.join(work,'setup-'+(dark?'dark':'light')+'.png'),fullPage:true});
      if(errors.length)failures.push({width,height,language,dark,errors});
      await page.close();
    }
    fs.writeFileSync(path.join(work,'browser-evidence.json'),JSON.stringify({states,failures,mail:'mocked receipt for code-form geometry only; no real mail'},null,2));
    assert.deepEqual(failures,[],'Installed browser geometry or runtime errors: '+JSON.stringify(failures));
    return {states:states.length,failures:0};
  } finally { await context.close(); }
}
module.exports = { browserProof };
