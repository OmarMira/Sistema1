'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLanguageStore } from '@/store/language-store';

interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: 'post' | 'void' | null;
  loading: boolean;
  onConfirm: () => void;
}

export function ConfirmActionDialog({
  open,
  onOpenChange,
  action,
  loading,
  onConfirm,
}: ConfirmActionDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>
            {action === 'post' ? t('journal.confirmPost') : t('journal.confirmVoid')}
          </DialogTitle>
          <DialogDescription>
            {action === 'post'
              ? t('journal.confirmPostDesc')
              : t('journal.confirmVoidDesc')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            {t('common.cancel')}
          </Button>
          <Button
            variant={action === 'void' ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={loading}
          >
            {loading && <Loader2 className="size-4 mr-1 animate-spin" />}
            {action === 'post' ? t('journal.postEntry') : t('journal.voidEntry')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
