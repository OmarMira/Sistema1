'use client';
import React, { useId, useState, type FormEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore, type Company, type User } from '@/store/auth-store';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';
import { getTranslation, translations } from '@/lib/i18n';
import styles from './InstallationWizard.module.css';

interface Verification { companies: Company[]; user: User }

/**
 * Installation copy lives in the shared locales (`installation.*`). The language
 * store stays the source of truth: before hydration it holds the default `es`, so
 * the wizard renders Spanish exactly as it always did, and a later locale switch
 * re-renders without a reload.
 */
function installationTranslator(language: string) {
  const dictionary = translations[language === 'en' ? 'en' : 'es'] as Record<string, unknown>;
  return (key: string) => getTranslation(dictionary, `installation.${key}`, `installation.${key}`);
}

export function InstallationWizard({ onBack }: { onBack: () => void }) {
  const language = useLanguageStore(s => s.language);
  const t = installationTranslator(language);
  const text = {
    title: t('title'), intro: t('intro'),
    steps: [t('steps.welcome'), t('steps.business'), t('steps.accounting'), t('steps.email'), t('steps.review')],
    welcome: t('welcome'), welcomeBody: t('welcomeBody'), local: t('local'),
    business: t('business'), currency: t('currency'), bank: t('bank'),
    fiscal: t('fiscal'), year: t('year'), month: t('month'), period: t('period'), calendar: t('calendar'), custom: t('custom'), weeks: t('weeks'),
    admin: t('admin'), first: t('first'), last: t('last'), email: t('email'), password: t('password'), confirm: t('confirm'), passwordHelp: t('passwordHelp'),
    review: t('review'), before: t('before'), code: t('code'), delivered: t('delivered'),
    mailFailed: t('mailFailed'), resendNote: t('resendNote'),
    start: t('start'), next: t('next'), back: t('back'), reviewButton: t('reviewButton'), send: t('send'), verify: t('verify'), resend: t('resend'), retry: t('retry'), busy: t('busy'), error: t('error'),
    showPassword: t('showPassword'), hidePassword: t('hidePassword'), showConfirmation: t('showConfirmation'), hideConfirmation: t('hideConfirmation'),
    mismatch: t('mismatch'), complete: t('complete'), ready: t('ready'),
  };
  const [step, setStep] = useState(0);
  const [business, setBusiness] = useState(''); const [currency, setCurrency] = useState('USD');
  const [year, setYear] = useState(new Date().getFullYear()); const [month, setMonth] = useState(1); const [period, setPeriod] = useState('CALENDAR');
  const [firstName, setFirst] = useState(''); const [lastName, setLast] = useState(''); const [email, setEmail] = useState('');
  const [password, setPassword] = useState(''); const [confirmPassword, setConfirm] = useState(''); const [code, setCode] = useState('');
  const passwordId = useId(); const confirmationId = useId();
  const [showPassword, setShowPassword] = useState(false); const [showConfirmation, setShowConfirmation] = useState(false);
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
  const label = (name: string, id: string, field: React.ReactNode, fullWidth = false) => <label className={`${styles.field}${fullWidth ? ` ${styles.fullWidth}` : ''}`} htmlFor={id}>{name}{field}</label>;
  return <div className={styles.shell}>
    <header className={styles.header}><strong><span className={styles.badge}>AE</span> AccountExpress Next Gen</strong><div className={styles.controls}><LanguageSelector /><ThemeToggle /></div></header>
    <main className={styles.main}>
      <div className={styles.intro}><h1>{text.title}</h1><p>{text.intro}</p></div>
      <ol className={styles.steps} aria-label={text.title}>{text.steps.map((title, index) => <li key={title} aria-current={index === step ? 'step' : undefined}>{index + 1}. {title}</li>)}</ol>
      <form className={styles.card} onSubmit={submit}>
        {finished ? <section><h2>{text.complete}</h2><p>{text.ready}</p></section> : <>
          {step === 0 && <section><h2>{text.welcome}</h2><p>{text.welcomeBody}</p><aside className={styles.note}>{text.local}</aside></section>}
          {step === 1 && <section className={styles.layout}><div><h2>{text.steps[1]}</h2><p>{text.bank}</p></div><div>{label(text.business,'installation-business',<input id="installation-business" required minLength={3} maxLength={200} value={business} onChange={e=>setBusiness(e.target.value)} autoComplete="organization" />)}{label(text.currency,'installation-currency',<select id="installation-currency" value={currency} onChange={e=>setCurrency(e.target.value)}>{['USD','EUR','MXN','ARS','GBP'].map(value=><option key={value}>{value}</option>)}</select>)}</div></section>}
          {step === 2 && <section className={styles.layout}><div><h2>{text.fiscal}</h2><p>{text.bank}</p></div><div className={styles.fields}>{label(text.year,'installation-year',<input id="installation-year" type="number" required min={2000} max={2100} value={year} onChange={e=>setYear(Number(e.target.value))}/>)}{label(text.month,'installation-month',<select id="installation-month" value={month} onChange={e=>setMonth(Number(e.target.value))}>{Array.from({length:12},(_,i)=><option value={i+1} key={i}>{new Intl.DateTimeFormat(language,{month:'long'}).format(new Date(2024,i,1))}</option>)}</select>)}{label(text.period,'installation-period',<select id="installation-period" value={period} onChange={e=>setPeriod(e.target.value)}><option value="CALENDAR">{text.calendar}</option><option value="CUSTOM_MONTHS">{text.custom}</option><option value="WEEK_52_53">{text.weeks}</option></select>)}</div></section>}
          {step === 3 && <section className={styles.layout}><div><h2>{text.admin}</h2><p>{text.passwordHelp}</p></div><div className={styles.fields}>{label(text.first,'installation-first-name',<input id="installation-first-name" required value={firstName} onChange={e=>setFirst(e.target.value)} autoComplete="given-name"/>)}{label(text.last,'installation-last-name',<input id="installation-last-name" required value={lastName} onChange={e=>setLast(e.target.value)} autoComplete="family-name"/>)}
            {label(text.email,'installation-email',<input id="installation-email" required type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email"/>,true)}
            <div className={styles.field}><label htmlFor={passwordId}>{text.password}</label><div className={styles.passwordControl}><input id={passwordId} required type={showPassword ? 'text' : 'password'} minLength={8} value={password} onChange={e=>setPassword(e.target.value)} autoComplete="new-password"/><button type="button" className={styles.passwordToggle} aria-label={showPassword ? text.hidePassword : text.showPassword} title={showPassword ? text.hidePassword : text.showPassword} aria-pressed={showPassword} aria-controls={passwordId} onClick={()=>setShowPassword(value=>!value)}>{showPassword ? <EyeOff size={20} aria-hidden="true"/> : <Eye size={20} aria-hidden="true"/>}</button></div></div>
            <div className={styles.field}><label htmlFor={confirmationId}>{text.confirm}</label><div className={styles.passwordControl}><input id={confirmationId} required type={showConfirmation ? 'text' : 'password'} minLength={8} value={confirmPassword} onChange={e=>setConfirm(e.target.value)} autoComplete="new-password"/><button type="button" className={styles.passwordToggle} aria-label={showConfirmation ? text.hideConfirmation : text.showConfirmation} title={showConfirmation ? text.hideConfirmation : text.showConfirmation} aria-pressed={showConfirmation} aria-controls={confirmationId} onClick={()=>setShowConfirmation(value=>!value)}>{showConfirmation ? <EyeOff size={20} aria-hidden="true"/> : <Eye size={20} aria-hidden="true"/>}</button></div></div></div></section>}
          {step === 4 && <section className={styles.layout}><div><h2>{text.review}</h2><p>{text.before}</p></div><div><dl className={styles.summary}><dt>{text.business}</dt><dd>{business}</dd><dt>{text.currency}</dt><dd>{currency}</dd><dt>{text.fiscal}</dt><dd>{year} / {month} · {period}</dd><dt>{text.admin}</dt><dd>{firstName} {lastName} · {email}</dd></dl>{sent && !verified && label(text.code,'installation-code',<input id="installation-code" required inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={e=>setCode(e.target.value)} autoComplete="one-time-code"/>)}{sent && !verified && <button type="button" disabled={busy} onClick={()=>void resend()}>{text.resend}</button>}</div></section>}
          {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.note} role="status">{notice}</p>}
          <nav className={styles.actions}><button type="button" disabled={busy || !!verified} onClick={()=>{setError('');setNotice('');setSent(false);if(step===0)onBack();else setStep(step-1);}}>{text.back}</button><button type="submit" disabled={busy} className={styles.primary}>{busy ? text.busy : step === 0 ? text.start : step < 3 ? text.next : step === 3 ? text.reviewButton : verified ? text.retry : sent ? text.verify : text.send}</button></nav>
        </>}
      </form>
    </main><footer className={styles.footer}>AccountExpress Next Gen · {text.local}</footer>
  </div>;
}
