'use client';

import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useLanguageStore } from '@/store/language-store';
import { AccountSelector, type GlAccountOption } from '../journal/AccountSelector';
import { formatNumberWithComas } from './bank-utils';

const CURRENCIES = [
  { value: 'USD', label: 'USD - US Dollar' },
  { value: 'EUR', label: 'EUR - Euro' },
  { value: 'GBP', label: 'GBP - British Pound' },
  { value: 'ARS', label: 'ARS - Argentine Peso' },
  { value: 'BRL', label: 'BRL - Brazilian Real' },
  { value: 'MXN', label: 'MXN - Mexican Peso' },
  { value: 'UYU', label: 'UYU - Uruguayan Peso' },
  { value: 'CLP', label: 'CLP - Chilean Peso' },
  { value: 'COP', label: 'COP - Colombian Peso' },
  { value: 'PEN', label: 'PEN - Peruvian Sol' },
];

interface BankFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingAccount: { id: string; accountName: string; bankName: string; accountNo: string | null; routingNo: string | null; glAccountId: string; balance: number; initialBalance: number; currency: string } | null;
  saving: boolean;
  formAccountName: string;
  onFormAccountNameChange: (val: string) => void;
  formBankName: string;
  onFormBankNameChange: (val: string) => void;
  formAccountNo: string;
  onFormAccountNoChange: (val: string) => void;
  formRoutingNo: string;
  onFormRoutingNoChange: (val: string) => void;
  formGlAccountId: string | null;
  onFormGlAccountIdChange: (val: string | null) => void;
  formBalance: string;
  onFormBalanceChange: (val: string) => void;
  formCurrency: string;
  onFormCurrencyChange: (val: string) => void;
  formError: string;
  assetAccounts: GlAccountOption[];
  onSave: () => void;
}

export function BankFormDialog({
  open,
  onOpenChange,
  editingAccount,
  saving,
  formAccountName,
  onFormAccountNameChange,
  formBankName,
  onFormBankNameChange,
  formAccountNo,
  onFormAccountNoChange,
  formRoutingNo,
  onFormRoutingNoChange,
  formGlAccountId,
  onFormGlAccountIdChange,
  formBalance,
  onFormBalanceChange,
  formCurrency,
  onFormCurrencyChange,
  formError,
  assetAccounts,
  onSave,
}: BankFormDialogProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <Dialog
      open={open}
      onOpenChange={(val) => {
        onOpenChange(val);
      }}
    >
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            {editingAccount ? t('banks.editBankAccount') : t('banks.newBankAccount')}
          </DialogTitle>
          <DialogDescription>
            {editingAccount ? t('banks.editAccountDesc') : t('banks.newAccountDesc')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('common.name')} <span className="text-red-500">*</span>
            </label>
            <Input
              placeholder="e.g. Business Checking"
              value={formAccountName}
              onChange={(e) => onFormAccountNameChange(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('banks.bankName')} <span className="text-red-500">*</span>
            </label>
            <Input
              placeholder="e.g. Chase Bank"
              value={formBankName}
              onChange={(e) => onFormBankNameChange(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('banks.accountNumber')}</label>
              <Input
                placeholder="e.g. 123456789"
                value={formAccountNo}
                onChange={(e) => onFormAccountNoChange(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('banks.routingNumber')}</label>
              <Input
                placeholder="e.g. 021000021"
                value={formRoutingNo}
                onChange={(e) => onFormRoutingNoChange(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t('banks.linkedAccount')} <span className="text-red-500">*</span>
            </label>
            <AccountSelector
              accounts={assetAccounts}
              value={formGlAccountId}
              onChange={onFormGlAccountIdChange}
              placeholder="Select asset account"
            />
            <p className="text-xs text-muted-foreground">{t('banks.linkedAccountHelp')}</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('banks.startingBalance')}</label>
              <Input
                type="text"
                placeholder="0.00"
                value={formBalance}
                onChange={(e) => onFormBalanceChange(formatNumberWithComas(e.target.value))}
                className="font-mono text-right"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t('banks.currency')}</label>
              <Select value={formCurrency} onValueChange={onFormCurrencyChange}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {formError && <p className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button onClick={onSave} disabled={saving}>
            {saving && <Loader2 className="size-4 mr-1 animate-spin" />}
            {t('common.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
