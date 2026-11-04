'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLanguageStore } from '@/store/language-store';

/** S7: the server requires a reason of 5..500 characters to void an entry. */
const VOID_REASON_MIN = 5;
const VOID_REASON_MAX = 500;

interface ConfirmActionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: 'post' | 'void' | null;
  loading: boolean;
  onConfirm: () => void;
  /** Reason for the void action (ignored for 'post'). */
  reason?: string;
  onReasonChange?: (reason: string) => void;
}

export function ConfirmActionDialog({
  open,
  onOpenChange,
  action,
  loading,
  onConfirm,
  reason = '',
  onReasonChange,
}: ConfirmActionDialogProps) {
  const t = useLanguageStore((s) => s.t);

  const isVoid = action === 'void';
  // The confirm button mirrors the server rule, so an operator cannot submit a
  // void the API will reject: 5..500 characters after trimming.
  const voidReasonValid = !isVoid || reason.trim().length >= VOID_REASON_MIN;

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
        {isVoid && (
          <div className="space-y-1.5">
            <label htmlFor="journal-void-reason" className="text-sm font-medium">
              {t('journal.voidReasonLabel')}
              <span aria-hidden="true" className="text-destructive"> *</span>
            </label>
            <Input
              id="journal-void-reason"
              value={reason}
              onChange={(event) => onReasonChange?.(event.target.value)}
              placeholder={t('journal.voidReasonPlaceholder')}
              maxLength={VOID_REASON_MAX}
              disabled={loading}
              required
              autoComplete="off"
              aria-required="true"
              aria-describedby="journal-void-reason-hint"
              aria-label={t('journal.voidReasonLabel')}
            />
            <p id="journal-void-reason-hint" className="text-xs text-muted-foreground">
              {t('journal.voidReasonHint')}
            </p>
          </div>
        )}
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
            disabled={loading || !voidReasonValid}
          >
            {loading && <Loader2 className="size-4 mr-1 animate-spin" />}
            {action === 'post' ? t('journal.postEntry') : t('journal.voidEntry')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
