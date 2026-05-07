'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import { motion, useInView } from 'framer-motion';
import {
  BookOpen,
  ArrowLeftRight,
  FileText,
  BarChart3,
  Upload,
  Globe,
  Shield,
  Zap,
  Clock,
  Users,
  UserPlus,
  Landmark,
  Sparkles,
  CheckCircle2,
  Lock,
  Server,
  FileCheck,
  KeyRound,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ThemeToggle } from '@/components/spa/ThemeToggle';
import { LanguageSelector } from '@/components/spa/LanguageSelector';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';

/* ─── Animation Variants ─── */

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.5, ease: 'easeOut' as const },
  }),
};

const fadeIn = {
  hidden: { opacity: 0 },
  visible: (i: number) => ({
    opacity: 1,
    transition: { delay: i * 0.1, duration: 0.6, ease: 'easeOut' as const },
  }),
};

const scaleIn = {
  hidden: { opacity: 0, scale: 0.9 },
  visible: (i: number) => ({
    opacity: 1,
    scale: 1,
    transition: { delay: i * 0.15, duration: 0.5, ease: 'easeOut' as const },
  }),
};

/* ─── Counter Hook ─── */

function useCounter(end: number, duration: number = 2000, inView: boolean) {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!inView) return;
    let startTime: number | null = null;
    let animationFrame: number;

    const animate = (timestamp: number) => {
      if (!startTime) startTime = timestamp;
      const progress = Math.min((timestamp - startTime) / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      setCount(Math.floor(eased * end));
      if (progress < 1) {
        animationFrame = requestAnimationFrame(animate);
      }
    };

    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [end, duration, inView]);

  return count;
}

/* ─── Counter Display Component ─── */

function StatCounter({
  valueKey,
  labelKey,
  numericValue,
  suffix,
  t,
  inView,
}: {
  valueKey: string;
  labelKey: string;
  numericValue: number;
  suffix: string;
  t: (key: string) => string;
  inView: boolean;
}) {
  const count = useCounter(numericValue, 2200, inView);
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <span className="text-4xl font-bold tracking-tight text-primary sm:text-5xl">
        {count.toLocaleString()}
        {suffix}
      </span>
      <span className="text-sm font-medium text-muted-foreground">
        {t(labelKey)}
      </span>
    </div>
  );
}

/* ─── Step Number Badge ─── */

function StepNumber({ num }: { num: number }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-lg font-bold shadow-lg shadow-primary/25">
      {num}
    </div>
  );
}

/* ─── Security Badge ─── */

function SecurityBadge({
  icon: Icon,
  labelKey,
  t,
}: {
  icon: React.ComponentType<{ className?: string }>;
  labelKey: string;
  t: (key: string) => string;
}) {
  return (
    <motion.div variants={scaleIn} custom={0} className="flex items-center gap-2.5 rounded-xl border bg-card px-4 py-3 transition-shadow hover:shadow-md">
      <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10">
        <Icon className="size-4 text-primary" />
      </div>
      <span className="text-sm font-medium">{t(labelKey)}</span>
    </motion.div>
  );
}

/* ─── Static Data ─── */

const features = [
  {
    icon: BookOpen,
    titleKey: 'auth.featureAccounts',
    descKey: 'auth.featureAccountsDesc',
  },
  {
    icon: ArrowLeftRight,
    titleKey: 'auth.featureReconciliation',
    descKey: 'auth.featureReconciliationDesc',
  },
  {
    icon: FileText,
    titleKey: 'auth.featureJournal',
    descKey: 'auth.featureJournalDesc',
  },
  {
    icon: BarChart3,
    titleKey: 'auth.featureReports',
    descKey: 'auth.featureReportsDesc',
  },
  {
    icon: Upload,
    titleKey: 'landing.featureImport',
    descKey: 'landing.featureImportDesc',
  },
  {
    icon: Globe,
    titleKey: 'landing.featureMultilang',
    descKey: 'landing.featureMultilangDesc',
  },
];

const trustItems = [
  { icon: Shield, labelKey: 'landing.trustSecurity' },
  { icon: Zap, labelKey: 'landing.trustFast' },
  { icon: Clock, labelKey: 'landing.trustUptime' },
  { icon: Users, labelKey: 'landing.trustUsers' },
];

const steps = [
  {
    icon: UserPlus,
    titleKey: 'landing.step1Title',
    descKey: 'landing.step1Desc',
  },
  {
    icon: Landmark,
    titleKey: 'landing.step2Title',
    descKey: 'landing.step2Desc',
  },
  {
    icon: Sparkles,
    titleKey: 'landing.step3Title',
    descKey: 'landing.step3Desc',
  },
];

const securityBadges = [
  { icon: FileCheck, labelKey: 'landing.badgeSoc2' },
  { icon: Shield, labelKey: 'landing.badgeGdpr' },
  { icon: Lock, labelKey: 'landing.badgeEncryption' },
  { icon: Server, labelKey: 'landing.badgeBackup' },
  { icon: CheckCircle2, labelKey: 'landing.badgeAudit' },
  { icon: KeyRound, labelKey: 'landing.badgeSso' },
];

/* ─── Main Component ─── */

export function LandingPage() {
  const t = useLanguageStore((s) => s.t);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

  const statsRef = useRef<HTMLDivElement>(null);
  const statsInView = useInView(statsRef, { once: true, margin: '-100px' });

  return (
    <div className="flex min-h-screen flex-col">
      {/* ── Top Nav ── */}
      <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground font-bold text-sm">
              AE
            </div>
            <span className="text-lg font-semibold tracking-tight">
              {t('common.appName')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <LanguageSelector />
            <ThemeToggle />
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCurrentView('login')}
              className="hidden sm:inline-flex"
            >
              {t('auth.login')}
            </Button>
            <Button
              size="sm"
              onClick={() => setCurrentView('register')}
            >
              {t('auth.register')}
            </Button>
          </div>
        </div>
      </header>

      {/* ── Hero ── */}
      <main className="flex-1">
        <section className="relative overflow-hidden">
          {/* Animated gradient background */}
          <div className="pointer-events-none absolute inset-0 -z-10">
            <div
              className="absolute inset-0 animate-gradient-shift"
              style={{
                background:
                  'linear-gradient(135deg, hsl(var(--primary) / 0.08) 0%, hsl(var(--primary) / 0.03) 25%, transparent 50%, hsl(var(--primary) / 0.05) 75%, hsl(var(--primary) / 0.08) 100%)',
                backgroundSize: '300% 300%',
              }}
            />
            <div
              className="absolute inset-0 animate-gradient-shift-slow opacity-50"
              style={{
                background:
                  'radial-gradient(ellipse 80% 60% at 20% 40%, hsl(var(--primary) / 0.12) 0%, transparent 60%), radial-gradient(ellipse 60% 80% at 80% 60%, hsl(var(--primary) / 0.08) 0%, transparent 60%)',
                backgroundSize: '200% 200%',
              }}
            />
            {/* Grid pattern overlay */}
            <div
              className="absolute inset-0 opacity-[0.015]"
              style={{
                backgroundImage:
                  'linear-gradient(hsl(var(--foreground)) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--foreground)) 1px, transparent 1px)',
                backgroundSize: '64px 64px',
              }}
            />
          </div>

          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28 lg:px-8 lg:py-36">
            <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
              {/* Copy */}
              <motion.div
                initial="hidden"
                animate="visible"
                className="flex flex-col gap-6 text-center lg:text-left"
              >
                {/* Badge */}
                <motion.div custom={0} variants={fadeUp} className="mx-auto lg:mx-0">
                  <span className="inline-flex items-center gap-1.5 rounded-full border bg-background/80 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
                    <Zap className="size-3 text-primary" />
                    {t('landing.trustFast')}
                  </span>
                </motion.div>

                <motion.h1
                  custom={1}
                  variants={fadeUp}
                  className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl"
                >
                  {t('auth.landingTitle')}
                </motion.h1>
                <motion.p
                  custom={2}
                  variants={fadeUp}
                  className="text-lg text-muted-foreground sm:text-xl max-w-2xl mx-auto lg:mx-0"
                >
                  {t('auth.landingSubtitle')}
                </motion.p>
                <motion.div
                  custom={3}
                  variants={fadeUp}
                  className="flex flex-wrap gap-3 justify-center lg:justify-start"
                >
                  <Button
                    size="lg"
                    className="font-medium px-8 shadow-lg shadow-primary/25"
                    onClick={() => setCurrentView('register')}
                  >
                    {t('auth.getStarted')}
                  </Button>
                  <Button
                    variant="outline"
                    size="lg"
                    className="font-medium px-8"
                    onClick={() => {
                      document
                        .getElementById('features')
                        ?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    {t('auth.learnMore')}
                  </Button>
                </motion.div>
              </motion.div>

              {/* Hero Image */}
              <motion.div
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                transition={{ duration: 0.7, ease: 'easeOut', delay: 0.2 }}
                className="relative"
              >
                <div className="relative rounded-xl border bg-card p-2 shadow-2xl shadow-primary/5">
                  <div className="relative aspect-[16/10] overflow-hidden rounded-lg">
                    <Image
                      src="/hero-dashboard.png"
                      alt={t('auth.landingTitle')}
                      fill
                      className="object-cover"
                      priority
                    />
                  </div>
                </div>
                {/* Decorative blobs */}
                <div className="absolute -top-6 -right-6 -z-10 h-72 w-72 rounded-full bg-primary/10 blur-3xl" />
                <div className="absolute -bottom-6 -left-6 -z-10 h-72 w-72 rounded-full bg-primary/5 blur-3xl" />
                {/* Floating accent dot */}
                <motion.div
                  animate={{ y: [0, -8, 0] }}
                  transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
                  className="absolute -right-3 top-1/4 size-4 rounded-full bg-primary/30 blur-sm"
                />
                <motion.div
                  animate={{ y: [0, 6, 0] }}
                  transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut', delay: 1 }}
                  className="absolute -left-2 bottom-1/3 size-3 rounded-full bg-primary/20 blur-sm"
                />
              </motion.div>
            </div>
          </div>
        </section>

        {/* ── Stats / Testimonials ── */}
        <section ref={statsRef} className="border-t bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-60px' }}
              className="text-center mb-12"
            >
              <motion.h2
                custom={0}
                variants={fadeUp}
                className="text-3xl font-bold tracking-tight sm:text-4xl"
              >
                {t('landing.statsTitle')}
              </motion.h2>
              <motion.p
                custom={1}
                variants={fadeUp}
                className="mt-3 text-muted-foreground text-lg"
              >
                {t('landing.statsSubtitle')}
              </motion.p>
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-40px' }}
              className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4"
            >
              <motion.div custom={0} variants={fadeIn}>
                <StatCounter
                  valueKey="landing.statBusinesses"
                  labelKey="landing.statBusinessesLabel"
                  numericValue={10000}
                  suffix="+"
                  t={t}
                  inView={statsInView}
                />
              </motion.div>
              <motion.div custom={1} variants={fadeIn}>
                <StatCounter
                  valueKey="landing.statReconciled"
                  labelKey="landing.statReconciledLabel"
                  numericValue={2}
                  suffix="B+"
                  t={t}
                  inView={statsInView}
                />
              </motion.div>
              <motion.div custom={2} variants={fadeIn}>
                <StatCounter
                  valueKey="landing.statUptime"
                  labelKey="landing.statUptimeLabel"
                  numericValue={99}
                  suffix=".9%"
                  t={t}
                  inView={statsInView}
                />
              </motion.div>
              <motion.div custom={3} variants={fadeIn}>
                <div className="flex flex-col items-center gap-2 text-center">
                  <span className="text-4xl font-bold tracking-tight text-primary sm:text-5xl">
                    24/7
                  </span>
                  <span className="text-sm font-medium text-muted-foreground">
                    {t('landing.statSupportLabel')}
                  </span>
                </div>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* ── Features ── */}
        <section id="features" className="border-t">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-80px' }}
              className="text-center mb-12"
            >
              <motion.h2
                custom={0}
                variants={fadeUp}
                className="text-3xl font-bold tracking-tight sm:text-4xl"
              >
                {t('auth.features')}
              </motion.h2>
              <motion.p
                custom={1}
                variants={fadeUp}
                className="mt-4 text-muted-foreground text-lg max-w-2xl mx-auto"
              >
                {t('landing.featuresSubtitle')}
              </motion.p>
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-60px' }}
              className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
            >
              {features.map((feature, i) => (
                <motion.div key={i} custom={i + 2} variants={fadeUp}>
                  <Card className="group h-full transition-all duration-300 hover:shadow-lg hover:-translate-y-1">
                    <CardHeader>
                      <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 transition-colors group-hover:bg-primary/20">
                        <feature.icon className="size-5 text-primary" />
                      </div>
                      <CardTitle className="text-lg">{t(feature.titleKey)}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        {t(feature.descKey)}
                      </p>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* ── How It Works ── */}
        <section className="border-t bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-80px' }}
              className="text-center mb-14"
            >
              <motion.h2
                custom={0}
                variants={fadeUp}
                className="text-3xl font-bold tracking-tight sm:text-4xl"
              >
                {t('landing.howItWorksTitle')}
              </motion.h2>
              <motion.p
                custom={1}
                variants={fadeUp}
                className="mt-4 text-muted-foreground text-lg max-w-2xl mx-auto"
              >
                {t('landing.howItWorksSubtitle')}
              </motion.p>
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-60px' }}
              className="relative grid gap-8 md:grid-cols-3"
            >
              {/* Connector line (desktop only) */}
              <div className="pointer-events-none absolute left-1/2 top-16 hidden h-0.5 w-[70%] -translate-x-1/2 bg-border md:block" />

              {steps.map((step, i) => (
                <motion.div
                  key={i}
                  custom={i + 2}
                  variants={fadeUp}
                  className="relative flex flex-col items-center text-center"
                >
                  <div className="relative mb-6">
                    <StepNumber num={i + 1} />
                    <div className="absolute -inset-2 rounded-full bg-primary/5 -z-10" />
                  </div>
                  <div className="mb-3 flex size-14 items-center justify-center rounded-2xl bg-primary/10">
                    <step.icon className="size-7 text-primary" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2">
                    {t(step.titleKey)}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed max-w-xs">
                    {t(step.descKey)}
                  </p>
                </motion.div>
              ))}
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
              className="mt-12 text-center"
            >
              <motion.div custom={0} variants={fadeUp}>
                <Button
                  size="lg"
                  className="font-medium px-8 shadow-lg shadow-primary/20"
                  onClick={() => setCurrentView('register')}
                >
                  {t('auth.getStarted')}
                </Button>
              </motion.div>
            </motion.div>
          </div>
        </section>

        {/* ── Trust Indicators ── */}
        <section className="border-t">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-60px' }}
              className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4"
            >
              {trustItems.map((item, i) => (
                <motion.div
                  key={i}
                  custom={i}
                  variants={fadeUp}
                  className="flex flex-col items-center gap-3 text-center"
                >
                  <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
                    <item.icon className="size-6 text-primary" />
                  </div>
                  <p className="text-sm font-medium text-muted-foreground">
                    {t(item.labelKey)}
                  </p>
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* ── Social Proof / Security Badges ── */}
        <section className="border-t bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20 lg:px-8">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-60px' }}
              className="text-center mb-10"
            >
              <motion.h2
                custom={0}
                variants={fadeUp}
                className="text-2xl font-bold tracking-tight sm:text-3xl"
              >
                {t('landing.socialProofTitle')}
              </motion.h2>
              <motion.p
                custom={1}
                variants={fadeUp}
                className="mt-3 text-muted-foreground text-base max-w-xl mx-auto"
              >
                {t('landing.socialProofSubtitle')}
              </motion.p>
            </motion.div>

            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: '-40px' }}
              className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
            >
              {securityBadges.map((badge, i) => (
                <motion.div key={i} custom={i} variants={scaleIn}>
                  <SecurityBadge
                    icon={badge.icon}
                    labelKey={badge.labelKey}
                    t={t}
                  />
                </motion.div>
              ))}
            </motion.div>
          </div>
        </section>

        {/* ── CTA ── */}
        <section className="relative border-t overflow-hidden">
          {/* Subtle gradient bg */}
          <div className="pointer-events-none absolute inset-0 -z-10">
            <div
              className="absolute inset-0"
              style={{
                background:
                  'radial-gradient(ellipse 80% 50% at 50% 0%, hsl(var(--primary) / 0.06) 0%, transparent 70%)',
              }}
            />
          </div>

          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-24 lg:px-8 text-center">
            <motion.div
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true }}
            >
              <motion.h2
                custom={0}
                variants={fadeUp}
                className="text-3xl font-bold tracking-tight sm:text-4xl"
              >
                {t('landing.ctaTitle')}
              </motion.h2>
              <motion.p
                custom={1}
                variants={fadeUp}
                className="mt-4 text-muted-foreground text-lg max-w-xl mx-auto"
              >
                {t('landing.ctaSubtitle')}
              </motion.p>
              <motion.div
                custom={2}
                variants={fadeUp}
                className="mt-8 flex flex-wrap justify-center gap-3"
              >
                <Button
                  size="lg"
                  className="font-medium px-8 shadow-lg shadow-primary/25"
                  onClick={() => setCurrentView('register')}
                >
                  {t('auth.getStarted')}
                </Button>
                <Button
                  variant="outline"
                  size="lg"
                  className="font-medium px-8"
                  onClick={() => setCurrentView('login')}
                >
                  {t('auth.login')}
                </Button>
              </motion.div>
            </motion.div>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="border-t bg-muted/30">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
            <div className="flex items-center gap-2">
              <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground font-bold text-xs">
                AE
              </div>
              <span className="text-sm font-medium">
                {t('common.appName')}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              &copy; {new Date().getFullYear()} {t('common.appName')}.{' '}
              {t('landing.copyright')}
            </p>
          </div>
        </div>
      </footer>

      {/* ── Global Styles for Gradient Animation ── */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes gradient-shift {
          0% { background-position: 0% 50%; }
          50% { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        .animate-gradient-shift {
          animation: gradient-shift 8s ease infinite;
        }
        .animate-gradient-shift-slow {
          animation: gradient-shift 12s ease infinite reverse;
        }
      ` }} />
    </div>
  );
}
