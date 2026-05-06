'use client';

import Image from 'next/image';
import { motion } from 'framer-motion';
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

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.1, duration: 0.5, ease: 'easeOut' as const },
  }),
};

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

export function LandingPage() {
  const t = useLanguageStore((s) => s.t);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);

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
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-24 lg:px-8">
            <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
              {/* Copy */}
              <motion.div
                initial="hidden"
                animate="visible"
                className="flex flex-col gap-6 text-center lg:text-left"
              >
                <motion.h1
                  custom={0}
                  variants={fadeUp}
                  className="text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl"
                >
                  {t('auth.landingTitle')}
                </motion.h1>
                <motion.p
                  custom={1}
                  variants={fadeUp}
                  className="text-lg text-muted-foreground sm:text-xl max-w-2xl mx-auto lg:mx-0"
                >
                  {t('auth.landingSubtitle')}
                </motion.p>
                <motion.div
                  custom={2}
                  variants={fadeUp}
                  className="flex flex-wrap gap-3 justify-center lg:justify-start"
                >
                  <Button
                    size="lg"
                    className="font-medium px-8"
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
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
                className="relative"
              >
                <div className="relative rounded-xl border bg-card p-2 shadow-2xl">
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
              </motion.div>
            </div>
          </div>
        </section>

        {/* ── Features ── */}
        <section id="features" className="border-t bg-muted/30">
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
                  <Card className="h-full transition-shadow hover:shadow-md">
                    <CardHeader>
                      <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10">
                        <feature.icon className="size-5 text-primary" />
                      </div>
                      <CardTitle className="text-lg">{t(feature.titleKey)}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-sm text-muted-foreground">
                        {t(feature.descKey)}
                      </p>
                    </CardContent>
                  </Card>
                </motion.div>
              ))}
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

        {/* ── CTA ── */}
        <section className="border-t bg-primary/5">
          <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8 text-center">
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
                className="mt-8 flex justify-center gap-3"
              >
                <Button
                  size="lg"
                  className="font-medium px-8"
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
    </div>
  );
}
