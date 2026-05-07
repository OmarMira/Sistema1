'use client';

import { useState } from 'react';
import {
  Zap,
  Search,
  CheckCircle2,
  Loader2,
  Brain,
  ArrowRight,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

/* ─── Animation Variants ──────────────────────────────────────── */

const containerVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.08 } },
};
const itemVariants = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

/* ─── Types ───────────────────────────────────────────────────── */

interface DetectedPattern {
  id: string;
  description: string;
  occurrences: number;
  suggestedAccount: string;
  suggestedAccountCode: string;
}

/* ─── AIRulesGeneratorTab ─────────────────────────────────────── */

export function AIRulesGeneratorTab() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);

  const [patterns, setPatterns] = useState<DetectedPattern[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [savingRules, setSavingRules] = useState<string[]>([]);

  async function handleScan() {
    if (!activeCompany?.id) return;
    setScanning(true);
    setPatterns([]);
    setScanned(false);

    try {
      const res = await fetch('/api/ai-assistant', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'detect-patterns',
          companyId: activeCompany.id,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setPatterns(data.patterns || []);
        setScanned(true);
        toast?.success?.(t('settings.aiRules.scanComplete'));
      } else {
        setPatterns([]);
        setScanned(true);
      }
    } catch {
      setPatterns([]);
      setScanned(true);
    }

    setScanning(false);
  }

  async function handleSaveRule(pattern: DetectedPattern) {
    setSavingRules((prev) => [...prev, pattern.id]);
    // Simulate save delay
    await new Promise((resolve) => setTimeout(resolve, 1000));
    setSavingRules((prev) => prev.filter((id) => id !== pattern.id));
  }

  async function handleSaveAll() {
    const ids = patterns.map((p) => p.id);
    setSavingRules(ids);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    setSavingRules([]);
  }

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="visible"
      className="space-y-6"
    >
      {/* Header */}
      <motion.div variants={itemVariants}>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Brain className="size-5 text-violet-500" />
              {t('settings.aiRules.title')}
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              {t('settings.aiRules.subtitle')}
            </p>
          </div>
          {scanned && patterns.length > 0 && (
            <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 border-0 self-start">
              <CheckCircle2 className="size-3 mr-1" />
              {patterns.length} {t('settings.aiRules.created')}
            </Badge>
          )}
        </div>
      </motion.div>

      {/* Scan Button */}
      <motion.div variants={itemVariants}>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('settings.aiRules.title')}</CardTitle>
            <CardDescription>{t('settings.aiRules.subtitle')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={handleScan} disabled={scanning} className="gap-2">
              {scanning ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('settings.aiRules.scanning')}
                </>
              ) : (
                <>
                  <Search className="size-4" />
                  {t('settings.aiRules.scanTransactions')}
                </>
              )}
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Empty State */}
      {scanned && patterns.length === 0 && !scanning && (
        <motion.div
          variants={itemVariants}
          className="text-center py-16"
        >
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center justify-center size-16 rounded-full bg-emerald-100 dark:bg-emerald-900/30">
              <CheckCircle2 className="size-8 text-emerald-500" />
            </div>
            <p className="text-sm text-muted-foreground max-w-md">
              {t('settings.aiRules.noPatterns')}
            </p>
          </div>
        </motion.div>
      )}

      {/* Detected Patterns */}
      {patterns.length > 0 && (
        <motion.div variants={itemVariants}>
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Zap className="size-4 text-amber-500" />
                  {t('settings.aiRules.patternFound')}
                </CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSaveAll}
                  disabled={savingRules.length === patterns.length}
                >
                  {savingRules.length === patterns.length ? (
                    <Loader2 className="size-3.5 mr-1 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-3.5 mr-1" />
                  )}
                  {t('settings.aiRules.saveAllRules')}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {patterns.map((pattern) => (
                <motion.div
                  key={pattern.id}
                  initial={{ opacity: 0, x: -10 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="rounded-lg border p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="space-y-1">
                    <p className="text-sm font-medium">{pattern.description}</p>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>{pattern.occurrences} {t('settings.aiRules.occurrences')}</span>
                      <span className="flex items-center gap-1">
                        <ArrowRight className="size-3" />
                        {t('settings.aiRules.suggestedAccount')}: {pattern.suggestedAccountCode} - {pattern.suggestedAccount}
                      </span>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleSaveRule(pattern)}
                    disabled={savingRules.includes(pattern.id)}
                  >
                    {savingRules.includes(pattern.id) ? (
                      <Loader2 className="size-3.5 mr-1 animate-spin" />
                    ) : (
                      <CheckCircle2 className="size-3.5 mr-1" />
                    )}
                    {t('settings.aiRules.saveRule')}
                  </Button>
                </motion.div>
              ))}
            </CardContent>
          </Card>
        </motion.div>
      )}
    </motion.div>
  );
}
