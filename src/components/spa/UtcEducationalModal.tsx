'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Info, Globe } from 'lucide-react';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';

export function UtcEducationalModal({ children }: { children?: React.ReactNode }) {
  const t = useLanguageStore((s) => s.t);
  const setCurrentView = useAuthStore((s) => s.setCurrentView);
  const [open, setOpen] = useState(false);

  const handleGoToPeriods = () => {
    setOpen(false);
    // Redirección al panel de configuración de períodos en el SPA de forma fluida
    useAuthStore.getState().setSettingsActiveTab('periods');
    setCurrentView('settings');
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {children || (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs font-semibold text-amber-700 hover:text-amber-800 hover:bg-amber-100/50 dark:text-amber-400 dark:hover:text-amber-300 dark:hover:bg-amber-950/30 shrink-0 border border-amber-200 dark:border-amber-800/60 rounded-md"
          >
            <Info className="size-3.5" />
            <span>Soporte Didáctico</span>
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md border-amber-100 dark:border-amber-950">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-amber-600 dark:text-amber-400 font-bold">
            <Globe className="size-5" />
            {t('utc.modal.title')}
          </DialogTitle>
          <DialogDescription className="text-sm text-foreground pt-2 leading-relaxed">
            {t('utc.modal.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg bg-amber-500/5 border border-amber-500/10 p-3.5 text-xs text-muted-foreground leading-relaxed">
          {t('utc.modal.benefit')}
        </div>

        <DialogFooter className="sm:justify-start gap-2 pt-2 border-t border-muted/30">
          <Button variant="outline" size="sm" onClick={handleGoToPeriods} className="text-xs">
            {t('utc.modal.action')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            className="text-xs text-muted-foreground"
          >
            {t('utc.modal.close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
