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

interface DeleteConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deleting: boolean;
  accountName: string;
  bankName: string;
  onConfirm: () => void;
}

export function DeleteConfirmDialog({
  open,
  onOpenChange,
  deleting,
  accountName,
  bankName,
  onConfirm,
}: DeleteConfirmDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('banks.deactivateTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {t('banks.deactivateDesc')
              .replace('{name}', accountName)
              .replace('{bank}', bankName)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={deleting}
            className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
          >
            {deleting && <Loader2 className="size-4 mr-1 animate-spin" />}
            {t('banks.deactivateAction')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
