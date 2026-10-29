'use client';
import React, { useState, type FormEvent } from 'react';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore, type Company, type User } from '@/store/auth-store';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';
import styles from './InstallationWizard.module.css';

const copy = {
  es: {
    title: 'Asistente de instalación', intro: 'Un paso a la vez, sin conocimientos técnicos.',
    steps: ['Bienvenida', 'Tus datos', 'Inicio contable', 'Correo', 'Revisión'],
    welcome: 'Todo comienza por acá', welcomeBody: 'Vamos a preparar tu empresa y confirmar tu correo antes de crear el acceso al sistema.',
    local: 'La aplicación y tus datos contables quedan en esta PC. Solo la confirmación y recuperación de acceso utilizan el servicio de correo.',
    business: 'Nombre legal de tu empresa', currency: 'Moneda de trabajo', bank: 'Los saldos bancarios se incorporan al importar cada estado de cuenta. No se interpreta un saldo faltante como cero.',
    fiscal: '¿Cuándo empieza tu ejercicio contable?', year: 'Año de inicio del ejercicio', month: 'Mes de inicio del ejercicio', period: 'Tipo de período contable', calendar: 'Calendario natural', custom: 'Meses personalizados', weeks: 'Semanas 52/53',
    admin: 'Tu acceso al sistema', first: 'Nombre', last: 'Apellido', email: 'Correo electrónico', password: 'Contraseña', confirm: 'Confirmar contraseña', passwordHelp: 'Usá al menos 8 caracteres. La contraseña no se guarda en este navegador.',
    review: 'Revisá tus datos', before: 'Primero confirmaremos el correo. La empresa y el acceso se crearán solo cuando se acepte el código.',
    code: 'Código de verificación', delivered: 'El servicio aceptó el envío. Revisá tu bandeja de entrada y correo no deseado.',
    mailFailed: 'No se pudo enviar el correo. Revisá la configuración de correo antes de reintentar.',
    resendNote: 'Se solicitó un nuevo código. Esto no confirma que el correo haya llegado.',
    start: 'Comenzar', next: 'Continuar', back: 'Volver', reviewButton: 'Revisar', send: 'Enviar código', verify: 'Verificar y completar', resend: 'Solicitar otro código', retry: 'Reintentar configuración', busy: 'Procesando…', error: 'No se pudo completar la operación. Revisá los datos e intentá nuevamente.',
    mismatch: 'Las contraseñas no coinciden.', complete: 'Configuración completada', ready: 'Los datos guardados fueron confirmados por el sistema.',
  },
  en: {
    title: 'Installation assistant', intro: 'One step at a time. No technical knowledge required.',
    steps: ['Welcome', 'Your business', 'Accounting start', 'Email', 'Review'],
    welcome: 'Start here', welcomeBody: 'Prepare your company and verify your email before creating system access.',
    local: 'The application and accounting records stay on this PC. Only verification and recovery use the email service.',
    business: 'Company legal name', currency: 'Working currency', bank: 'Bank balances are recorded when each statement is imported. Missing balances are not treated as confirmed zero.',
    fiscal: 'When does your fiscal year start?', year: 'Fiscal start year', month: 'Fiscal start month', period: 'Accounting period type', calendar: 'Calendar', custom: 'Custom months', weeks: '52/53 weeks',
    admin: 'Your system access', first: 'First name', last: 'Last name', email: 'Email address', password: 'Password', confirm: 'Confirm password', passwordHelp: 'Use at least 8 characters. Your password is not stored in this browser.',
    review: 'Review your details', before: 'Verify your email first. The company and account are created only after the code is accepted.',
    code: 'Verification code', delivered: 'The service accepted the message. Check your inbox and spam folder.',
    mailFailed: 'Email could not be sent. Check the mail configuration before trying again.',
    resendNote: 'A new code was requested. This does not confirm inbox delivery.',
    start: 'Start', next: 'Continue', back: 'Back', reviewButton: 'Review', send: 'Send code', verify: 'Verify and finish', resend: 'Request another code', retry: 'Retry setup', busy: 'Working…', error: 'The operation could not be completed. Check your details and try again.',
    mismatch: 'Passwords do not match.', complete: 'Setup completed', ready: 'The system confirmed the saved configuration.',
  },
};
interface Verification { companies: Company[]; user: User }
export function InstallationWizard({ onBack }: { onBack: () => void }) {
  const language = useLanguageStore(s => s.language);
  const text = copy[language === 'en' ? 'en' : 'es'];
  const [step, setStep] = useState(0);
  const [business, setBusiness] = useState(''); const [currency, setCurrency] = useState('USD');
  const [year, setYear] = useState(new Date().getFullYear()); const [month, setMonth] = useState(1); const [period, setPeriod] = useState('CALENDAR');
  const [firstName, setFirst] = useState(''); const [lastName, setLast] = useState(''); const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''); const [confirmPassword, setConfirm] = useState(''); const [code, setCode] = useState('');
  const [sent, setSent] = useState(false); const [verified, setVerified] = useState<Verification | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [finished, setFinished] = useState(false);
  const registration = () => ({ email: email.trim().toLowerCase(), password, confirmPassword, firstName: firstName.trim(), lastName: lastName.trim(), companyName: business.trim(), entityType: 'BUSINESS' });
  async function request(url: string, body?: unknown, companyId?: string) {
    const res = await fetch(url, { method: body === undefined ? 'GET' : 'POST', credentials: 'include', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', ...(companyId ? { 'x-company-id': companyId } : {}) }, body: JSON.stringify(body) }) });
    const result = await res.json(); if (!res.ok) throw new Error(typeof result.error === 'string' ? result.error : text.error); return result;
  }
  async function finish(account: Verification) {
    const companyId = account.companies?.[0]?.id; if (!companyId) throw new Error(text.error);
    await request('/api/onboarding/complete', { companyId, legalName: business.trim(), currency, fiscalYearStartMonth: month, fiscalYearStartYear: year, periodType: period }, companyId);
    const truth = await request('/api/auth/me');
    const company = truth.companies?.find((entry: Company) => entry.id === companyId && entry.isOnboardingComplete);
    if (!truth.user || !company) throw new Error(text.error);
    const store = useAuthStore.getState(); store.setActiveCompany(company); store.login(truth.user); await store.hydrate();
    setPassword(''); setConfirm(''); setCode(''); setFinished(true);
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice('');
    if (step < 4) {
      if (step === 3 && password !== confirmPassword) { setError(text.mismatch); return; }
      setStep(step + 1); return;
    }
    setBusy(true);
    try {
      if (verified) await finish(verified);
      else if (!sent) {
        const result = await request('/api/auth/register', registration());
        if (!result.requiresVerification || result.deliveryFailed) throw new Error(text.mailFailed);
        setSent(true); setNotice(text.delivered);
      } else {
        const result = await request('/api/auth/verify', { ...registration(), code }) as Verification;
        setVerified(result); await finish(result);
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : text.error); }
    finally { setBusy(false); }
  }
  async function resend() {
    setBusy(true); setError(''); setNotice('');
    try { await request('/api/auth/resend-verification', { email: email.trim().toLowerCase() }); setNotice(text.resendNote); }
    catch (reason) { setError(reason instanceof Error ? reason.message : text.error); }
    finally { setBusy(false); }
  }
  const label = (name: string, field: React.ReactNode) => <label className={styles.field}>{name}{field}</label>;
  return <div className={styles.shell}>
    <header className={styles.header}><strong><span className={styles.badge}>AE</span> AccountExpress Next Gen</strong><div className={styles.controls}><LanguageSelector /><ThemeToggle /></div></header>
    <main className={styles.main}>
      <div className={styles.intro}><h1>{text.title}</h1><p>{text.intro}</p></div>
      <ol className={styles.steps} aria-label={text.title}>{text.steps.map((title, index) => <li key={title} aria-current={index === step ? 'step' : undefined}>{index + 1}. {title}</li>)}</ol>
      <form className={styles.card} onSubmit={submit}>
        {finished ? <section><h2>{text.complete}</h2><p>{text.ready}</p></section> : <>
          {step === 0 && <section><h2>{text.welcome}</h2><p>{text.welcomeBody}</p><aside className={styles.note}>{text.local}</aside></section>}
          {step === 1 && <section className={styles.layout}><div><h2>{text.steps[1]}</h2><p>{text.bank}</p></div><div>{label(text.business,<input required minLength={3} maxLength={200} value={business} onChange={e=>setBusiness(e.target.value)} autoComplete="organization" />)}{label(text.currency,<select value={currency} onChange={e=>setCurrency(e.target.value)}>{['USD','EUR','MXN','ARS','GBP'].map(value=><option key={value}>{value}</option>)}</select>)}</div></section>}
          {step === 2 && <section className={styles.layout}><div><h2>{text.fiscal}</h2><p>{text.bank}</p></div><div className={styles.fields}>{label(text.year,<input type="number" required min={2000} max={2100} value={year} onChange={e=>setYear(Number(e.target.value))}/>)}{label(text.month,<select value={month} onChange={e=>setMonth(Number(e.target.value))}>{Array.from({length:12},(_,i)=><option value={i+1} key={i}>{new Intl.DateTimeFormat(language,{month:'long'}).format(new Date(2024,i,1))}</option>)}</select>)}{label(text.period,<select value={period} onChange={e=>setPeriod(e.target.value)}><option value="CALENDAR">{text.calendar}</option><option value="CUSTOM_MONTHS">{text.custom}</option><option value="WEEK_52_53">{text.weeks}</option></select>)}</div></section>}
          {step === 3 && <section className={styles.layout}><div><h2>{text.admin}</h2><p>{text.passwordHelp}</p></div><div className={styles.fields}>{label(text.first,<input required value={firstName} onChange={e=>setFirst(e.target.value)} autoComplete="given-name"/>)}{label(text.last,<input required value={lastName} onChange={e=>setLast(e.target.value)} autoComplete="family-name"/>)}{label(text.email,<input required type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email"/>)}{label(text.password,<input required type="password" minLength={8} value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password"/>)}{label(text.confirm,<input required type="password" minLength={8} value={confirmPassword} onChange={e=>setConfirm(e.target.value)} autoComplete="new-password"/>)}</div></section>}
          {step === 4 && <section className={styles.layout}><div><h2>{text.review}</h2><p>{text.before}</p></div><div><dl className={styles.summary}><dt>{text.business}</dt><dd>{business}</dd><dt>{text.currency}</dt><dd>{currency}</dd><dt>{text.fiscal}</dt><dd>{year} / {month} · {period}</dd><dt>{text.admin}</dt><dd>{firstName} {lastName} · {email}</dd></dl>{sent && !verified && label(text.code,<input required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e=>setCode(e.target.value)} autoComplete="one-time-code"/>)}{sent && !verified && <button type="button" disabled={busy} onClick={()=>void resend()}>{text.resend}</button>}</div></section>}
          {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.note} role="status">{notice}</p>}
          <nav className={styles.actions}><button type="button" disabled={busy || !!verified} onClick={()=>{setError('');setNotice('');setSent(false);if(step===0)onBack();else setStep(step-1);}}>{text.back}</button><button type="submit" disabled={busy} className={styles.primary}>{busy ? text.busy : step === 0 ? text.start : step < 3 ? text.next : step === 3 ? text.reviewButton : verified ? text.retry : sent ? text.verify : text.send}</button></nav>
        </>}
      </form>
    </main><footer className={styles.footer}>AccountExpress Next Gen · {text.local}</footer>
  </div>;
}
