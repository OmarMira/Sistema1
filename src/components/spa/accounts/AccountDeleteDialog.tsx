'use client';

import { Loader2 } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useLanguageStore } from '@/store/language-store';
import type { GlAccount } from './AccountFormDialog';

interface Props {
  target: GlAccount | null;
  deleteError: string;
  deleting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function AccountDeleteDialog({
  target,
  deleteError,
  deleting,
  onOpenChange,
  onConfirm,
}: Props) {
  const t = useLanguageStore((s) => s.t);

  return (
    <AlertDialog open={!!target} onOpenChange={(open) => !open && onOpenChange(false)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('accounts.deleteAccount')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('accounts.confirmDelete')}
            {target && (
              <span className="block mt-2 font-semibold text-foreground">
                {target.code} — {target.name}
              </span>
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {deleteError && (
          <div className="rounded-md bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 p-3 text-sm text-rose-800 dark:text-rose-300">
            {deleteError}
          </div>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={deleting}
            className="bg-rose-600 hover:bg-rose-700 text-white"
          >
            {deleting && <Loader2 className="size-4 mr-2 animate-spin" />}
            {t('common.delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
