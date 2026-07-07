'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardFooter,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  Loader2,
  ShieldCheck,
  BarChart3,
  BookOpen,
} from 'lucide-react';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { logger } from '@/lib/logger';

// Pasos del Wizard
const STEPS = [
  { id: 1, title: 'Entidad', icon: ShieldCheck },
  { id: 2, title: 'Periodo Fiscal', icon: BookOpen },
  { id: 3, title: 'Plan de Cuentas', icon: BarChart3 },
  { id: 4, title: 'Impuestos', icon: AlertCircle },
  { id: 5, title: 'Saldos Iniciales', icon: BarChart3 },
  { id: 6, title: 'Finalizar', icon: CheckCircle2 },
];

export function OnboardingWizard() {
  const t = useLanguageStore((s) => s.t);
  const { activeCompany, hydrate } = useAuthStore();

  const [step, setStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Estado del formulario alineado con el Schema Zod del Backend
  const [formData, setFormData] = useState({
    legalName: activeCompany?.legalName || '',
    currency: 'USD',
    fiscalStartYear: '',
    fiscalStartMonth: '',
    periodType: 'CALENDAR',
    initialCashBalance: '0',
  });

  const handleNext = () => {
    setErrorMessage(null);
    if (step === 1 && !formData.legalName.trim()) {
      setErrorMessage('El nombre legal de la empresa es obligatorio.');
      return;
    }
    if (step === 2 && (!formData.fiscalStartYear || !formData.fiscalStartMonth)) {
      setErrorMessage('El año y el mes de inicio fiscal son obligatorios.');
      return;
    }
    setStep((s) => Math.min(s + 1, STEPS.length));
  };

  const handleBack = () => {
    setErrorMessage(null);
    setStep((s) => Math.max(s - 1, 1));
  };

  const handleComplete = async () => {
    if (!activeCompany?.id) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const response = await fetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany.id,
          legalName: formData.legalName,
          currency: formData.currency,
          fiscalYearStartMonth: parseInt(formData.fiscalStartMonth, 10),
          fiscalYearStartYear: parseInt(formData.fiscalStartYear, 10),
          periodType: formData.periodType,
          initialCashBalance: parseFloat(formData.initialCashBalance) || 0,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Error completando el onboarding');
      }

      setIsSuccess(true);
      // Recargar la sesión y la aplicación para aplicar cambios
      await hydrate();
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } catch (error: unknown) {
      logger.error(String(error));
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  };

  // Dynamic Focus Management when transitioning steps
  useEffect(() => {
    const timer = setTimeout(() => {
      if (isSuccess) return;
      
      switch (step) {
        case 1:
          if (formData.legalName.trim() !== '') {
            document.getElementById('onboarding-next-btn')?.focus();
          } else {
            document.getElementById('onboarding-legalName')?.focus();
          }
          break;
        case 2:
          document.getElementById('onboarding-fiscalStartYear')?.focus();
          break;
        case 3:
        case 4:
          document.getElementById('onboarding-next-btn')?.focus();
          break;
        case 5:
          const initialCashBalanceInput = document.getElementById('onboarding-initialCashBalance') as HTMLInputElement;
          if (initialCashBalanceInput) {
            initialCashBalanceInput.focus();
            initialCashBalanceInput.select();
          }
          break;
        case 6:
          document.getElementById('onboarding-complete-btn')?.focus();
          break;
        default:
          break;
      }
    }, 100);

    return () => clearTimeout(timer);
  }, [step, isSuccess, formData.legalName]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (step < STEPS.length) {
        handleNext();
      } else {
        handleComplete();
      }
    }
  };

  // Renderizado condicional por paso
  const renderStep = () => {
    switch (step) {
      case 1:
        return (
          <div className="space-y-4">
            <div>
              <Label>{t('onboarding.step1.legalName')}</Label>
              <Input
                id="onboarding-legalName"
                value={formData.legalName}
                onChange={(e) => setFormData({ ...formData, legalName: e.target.value })}
                placeholder="Ej: LQ & OM LLC"
                className="mt-1"
                onKeyDown={handleKeyDown}
              />
            </div>
            <div>
              <Label>{t('onboarding.step1.currency')}</Label>
              <Select
                value={formData.currency}
                onValueChange={(v) => setFormData({ ...formData, currency: v })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Seleccionar Divisa" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">USD - Dólar Estadounidense</SelectItem>
                  <SelectItem value="EUR">EUR - Euro</SelectItem>
                  <SelectItem value="MXN">MXN - Peso Mexicano</SelectItem>
                  <SelectItem value="ARS">ARS - Peso Argentino</SelectItem>
                  <SelectItem value="GBP">GBP - Libra Esterlina</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        );
      case 2:
        return (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>{t('onboarding.step2.startYear')}</Label>
                <Input
                  id="onboarding-fiscalStartYear"
                  type="number"
                  value={formData.fiscalStartYear}
                  onChange={(e) => setFormData({ ...formData, fiscalStartYear: e.target.value })}
                  className="mt-1"
                  onKeyDown={handleKeyDown}
                />
              </div>
              <div>
                <Label>{t('onboarding.step2.startMonth')}</Label>
                <Select
                  value={formData.fiscalStartMonth}
                  onValueChange={(v) => setFormData({ ...formData, fiscalStartMonth: v })}
                >
                  <SelectTrigger className="mt-1">
                    <SelectValue placeholder="Mes" />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 12 }, (_, i) => (
                      <SelectItem key={i + 1} value={String(i + 1)}>
                        {new Date(2000, i).toLocaleString('es', { month: 'long' }).toUpperCase()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <Label>{t('onboarding.step2.periodType')}</Label>
              <Select
                value={formData.periodType}
                onValueChange={(v) => setFormData({ ...formData, periodType: v })}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Tipo de Periodo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="CALENDAR">Calendario Natural</SelectItem>
                  <SelectItem value="CUSTOM_MONTHS">Meses Personalizados</SelectItem>
                  <SelectItem value="WEEK_52_53">Semanas 52/53</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        );
      case 3:
        return (
          <div className="text-center space-y-4 py-8">
            <BookOpen className="mx-auto h-12 w-12 text-primary/50" />
            <p className="text-sm text-muted-foreground">{t('onboarding.step3.description')}</p>
            <p className="text-xs text-primary font-semibold">{t('onboarding.step3.note')}</p>
          </div>
        );
      case 4:
        return (
          <div className="text-center space-y-4 py-8">
            <AlertCircle className="mx-auto h-12 w-12 text-yellow-500" />
            <p className="text-sm text-muted-foreground">{t('onboarding.step4.description')}</p>
            <p className="text-xs text-yellow-600 font-semibold">{t('onboarding.step4.note')}</p>
          </div>
        );
      case 5:
        return (
          <div className="space-y-4">
            <Label>{t('onboarding.step5.initialBalance')}</Label>
            <Input
              id="onboarding-initialCashBalance"
              type="number"
              value={formData.initialCashBalance}
              onChange={(e) => setFormData({ ...formData, initialCashBalance: e.target.value })}
              placeholder="0.00"
              className="mt-1"
              onKeyDown={handleKeyDown}
            />
            <p className="text-xs text-muted-foreground leading-relaxed">
              {t('onboarding.step5.help')}
            </p>
          </div>
        );
      case 6:
        return (
          <div className="text-center space-y-4 py-6">
            <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-500 animate-pulse" />
            <p className="font-semibold text-lg">{t('onboarding.step6.ready')}</p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t('onboarding.step6.confirm')}
            </p>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-teal-50/40 via-background to-indigo-50/20 p-4">
      <Card className="w-full max-w-lg shadow-2xl border-t-4 border-t-teal-600">
        <CardHeader>
          <CardTitle className="text-2xl font-bold tracking-tight text-foreground">
            {t('onboarding.title')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('onboarding.subtitle')}
          </CardDescription>
        </CardHeader>

        <CardContent className="min-h-[280px] flex flex-col justify-between">
          {isSuccess ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-center py-8 space-y-4 my-auto"
            >
              <CheckCircle2 className="mx-auto h-16 w-16 text-emerald-500 animate-bounce" />
              <h3 className="text-2xl font-bold text-foreground">
                {t('onboarding.success.title')}
              </h3>
              <p className="text-muted-foreground text-sm">{t('onboarding.success.description')}</p>
              <div className="animate-pulse text-sm text-teal-600 font-mono mt-4">
                Redirigiendo al sistema...
              </div>
            </motion.div>
          ) : (
            <div className="flex-1 flex flex-col justify-between">
              <div>
                <div className="mb-6">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-bold uppercase tracking-widest text-teal-600">
                      {t('onboarding.step')} {step} / {STEPS.length}
                    </span>
                    <span className="text-xs font-semibold text-muted-foreground">
                      {STEPS[step - 1].title}
                    </span>
                  </div>
                  <div className="h-2 bg-secondary rounded-full overflow-hidden">
                    <motion.div
                      className="h-full bg-teal-600"
                      initial={{ width: 0 }}
                      animate={{ width: `${(step / STEPS.length) * 100}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                </div>

                <AnimatePresence mode="wait">
                  <motion.div
                    key={step}
                    initial={{ opacity: 0, x: 15 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -15 }}
                    transition={{ duration: 0.2 }}
                  >
                    {renderStep()}
                  </motion.div>
                </AnimatePresence>
              </div>

              {errorMessage && (
                <div className="mt-4 p-3 bg-destructive/10 text-destructive rounded-lg flex items-center gap-2 text-xs font-medium border border-destructive/20">
                  <AlertCircle className="h-4 w-4 shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}
            </div>
          )}
        </CardContent>

        {!isSuccess && (
          <CardFooter className="flex justify-between pt-4 border-t bg-muted/20">
            <Button
              id="onboarding-back-btn"
              variant="ghost"
              onClick={handleBack}
              disabled={step === 1 || isLoading}
              className="text-muted-foreground hover:text-foreground"
            >
              {t('common.back')}
            </Button>

            {step < STEPS.length ? (
              <Button
                id="onboarding-next-btn"
                onClick={handleNext}
                disabled={isLoading}
                className="bg-teal-600 hover:bg-teal-700 text-white"
              >
                {t('common.next')} <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            ) : (
              <Button
                id="onboarding-complete-btn"
                onClick={handleComplete}
                disabled={isLoading}
                className="bg-teal-600 hover:bg-teal-700 text-white"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('onboarding.processing')}
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="mr-2 h-4 w-4" /> {t('onboarding.complete')}
                  </>
                )}
              </Button>
            )}
          </CardFooter>
        )}
      </Card>
    </div>
  );
}
