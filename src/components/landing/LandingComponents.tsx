'use client';

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
import { useCounter } from '@/lib/hooks/useCounter';

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
      <span className="text-sm font-medium text-muted-foreground">{t(labelKey)}</span>
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
    <motion.div
      variants={scaleIn}
      custom={0}
      className="flex items-center gap-2.5 rounded-xl border bg-card px-4 py-3 transition-shadow hover:shadow-md"
    >
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

export {
  fadeUp,
  fadeIn,
  scaleIn,
  StatCounter,
  StepNumber,
  SecurityBadge,
  features,
  trustItems,
};
