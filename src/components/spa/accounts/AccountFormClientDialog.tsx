'use client';

import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useLanguageStore } from '@/store/language-store';
import { ACCOUNT_TYPES } from '@/lib/constants/account-types';

const TYPE_HELPERS: Record<string, { en: string; es: string }> = {
  asset: {
    en: 'Resources owned by the company (cash, receivables, inventory)',
    es: 'Recursos propiedad de la empresa (efectivo, cuentas por cobrar, inventario)',
  },
  liability: {
    en: 'Debts and obligations (payables, loans, taxes)',
    es: 'Deudas y obligaciones (cuentas por pagar, préstamos, impuestos)',
  },
  equity: {
    en: "Owner's equity and retained earnings",
    es: 'Capital contable y utilidades retenidas',
  },
  revenue: { en: 'Income from business operations', es: 'Ingresos por operaciones del negocio' },
  expense: {
    en: 'Costs incurred in business operations',
    es: 'Costos incurridos en las operaciones del negocio',
  },
};

const BALANCE_HELPERS: Record<string, { en: string; es: string }> = {
  debit: {
    en: 'Increases with debits (Assets, Expenses)',
    es: 'Aumenta con cargos (Activos, Gastos)',
  },
  credit: {
    en: 'Increases with credits (Liabilities, Equity, Revenue)',
    es: 'Aumenta con abonos (Pasivos, Capital, Ingresos)',
  },
};

export interface GlAccount {
  id: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
  parentId: string | null;
  isActive: boolean;
  isSystem: boolean;
  createdAt: Date | string;
  updatedAt: Date | string;
  companyId: string;
  parent?: { id: string; code: string; name: string } | null;
  _count?: { children: number; journalLines: number };
  balance?: number;
}

export interface AccountFormData {
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
  parentId: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingAccount: GlAccount | null;
  formData: AccountFormData;
  formErrors: Record<string, string>;
  submitting: boolean;
  allAccountsForSelect: GlAccount[];
  onFormChange: (patch: Partial<AccountFormData>) => void;
  onSubmit: () => void;
}

export function AccountFormClientDialog({
  open,
  onOpenChange,
  editingAccount,
  formData,
  formErrors,
  submitting,
  allAccountsForSelect,
  onFormChange,
  onSubmit,
}: Props) {
  const t = useLanguageStore((s) => s.t);
  const language = useLanguageStore((s) => s.language);

  function getTypeHelper(type: string) {
    const h = TYPE_HELPERS[type];
    return h ? (h[language] ?? h.en) : '';
  }

  function getBalanceHelper(balance: string) {
    const h = BALANCE_HELPERS[balance];
    return h ? (h[language] ?? h.en) : '';
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editingAccount ? t('accounts.editAccount') : t('accounts.newAccount')}
          </DialogTitle>
          <DialogDescription>
            {editingAccount
              ? language === 'es'
                ? 'Modifica los detalles y la jerarquía de esta cuenta contable.'
                : 'Modify the details and hierarchy of this ledger account.'
              : language === 'es'
                ? 'Define el código, nombre y tipo para tu nueva cuenta contable.'
                : 'Define the code, name, and type for your new ledger account.'}
          </DialogDescription>
        </DialogHeader>

        {formErrors.general && (
          <div className="rounded-md bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800 p-3 text-sm text-rose-800 dark:text-rose-300">
            {formErrors.general}
          </div>
        )}

        <div className="grid gap-5 py-2">
          {/* Code + Name */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label
                htmlFor="account-code"
                className="flex items-center gap-1 font-semibold text-zinc-900 dark:text-zinc-100/90 text-sm"
              >
                {t('accounts.accountCode')} <span className="text-red-500">*</span>
              </Label>
              <Input
                id="account-code"
                placeholder="1000"
                value={formData.code}
                onChange={(e) => onFormChange({ code: e.target.value })}
                className={formErrors.code ? 'border-rose-500' : ''}
              />
              {formErrors.code && (
                <p className="text-xs text-rose-600 font-medium">{formErrors.code}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label
                htmlFor="account-name"
                className="flex items-center gap-1 font-semibold text-zinc-900 dark:text-zinc-100/90 text-sm"
              >
                {t('accounts.accountName')} <span className="text-red-500">*</span>
              </Label>
              <Input
                id="account-name"
                placeholder={language === 'es' ? 'Efectivo' : 'Cash'}
                value={formData.name}
                onChange={(e) => onFormChange({ name: e.target.value })}
                className={formErrors.name ? 'border-rose-500' : ''}
              />
              {formErrors.name && (
                <p className="text-xs text-rose-600 font-medium">{formErrors.name}</p>
              )}
            </div>
          </div>

          {/* Type + Balance */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="flex items-center gap-1 font-semibold text-zinc-900 dark:text-zinc-100/90 text-sm">
                {t('accounts.accountType')} <span className="text-red-500">*</span>
              </Label>
              <Select
                value={formData.accountType}
                onValueChange={(v) => onFormChange({ accountType: v })}
              >
                <SelectTrigger className={formErrors.accountType ? 'border-rose-500' : ''}>
                  <SelectValue placeholder={t('accounts.accountType')} />
                </SelectTrigger>
                <SelectContent>
                  {ACCOUNT_TYPES.map((type) => (
                    <SelectItem key={type} value={type}>
                      {t(`accounts.${type}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {formErrors.accountType && (
                <p className="text-xs text-rose-600 font-medium">{formErrors.accountType}</p>
              )}
              {formData.accountType && (
                <div className="rounded-md bg-teal-500/5 dark:bg-teal-500/10 border border-teal-500/20 p-2.5 text-[11px] text-teal-700 dark:text-teal-400 mt-1.5 leading-relaxed">
                  {getTypeHelper(formData.accountType)}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-1 font-semibold text-zinc-900 dark:text-zinc-100/90 text-sm">
                {t('accounts.normalBalance')} <span className="text-red-500">*</span>
              </Label>
              <Select
                value={formData.normalBalance}
                onValueChange={(v) => onFormChange({ normalBalance: v })}
              >
                <SelectTrigger className={formErrors.normalBalance ? 'border-rose-500' : ''}>
                  <SelectValue placeholder={t('accounts.normalBalance')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debit">{t('accounts.debit')}</SelectItem>
                  <SelectItem value="credit">{t('accounts.credit')}</SelectItem>
                </SelectContent>
              </Select>
              {formErrors.normalBalance && (
                <p className="text-xs text-rose-600 font-medium">{formErrors.normalBalance}</p>
              )}
              {formData.normalBalance && (
                <div className="rounded-md bg-indigo-500/5 dark:bg-indigo-500/10 border border-indigo-500/20 p-2.5 text-[11px] text-indigo-700 dark:text-indigo-400 mt-1.5 leading-relaxed">
                  {getBalanceHelper(formData.normalBalance)}
                </div>
              )}
            </div>
          </div>

          {/* Parent Account */}
          <div className="space-y-2 border-t pt-4 border-border/50">
            <Label className="font-semibold text-zinc-900 dark:text-zinc-100/90 text-sm">
              {t('accounts.parentAccount')}
            </Label>
            <Select value={formData.parentId} onValueChange={(v) => onFormChange({ parentId: v })}>
              <SelectTrigger>
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  <span className="text-muted-foreground">
                    {language === 'es' ? 'Ninguna (cuenta raíz)' : 'None (root account)'}
                  </span>
                </SelectItem>
                {allAccountsForSelect
                  .filter((a) => a.id !== editingAccount?.id)
                  .map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.code} — {a.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground/80 pl-1">
              {language === 'es'
                ? 'Opcional. Agrupa esta cuenta bajo una cuenta padre.'
                : 'Optional. Group this account under a parent account.'}
            </p>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={onSubmit}
            disabled={submitting}
            className="bg-teal-600 hover:bg-teal-700 text-white"
          >
            {submitting && <Loader2 className="size-4 mr-2 animate-spin" />}
            {editingAccount ? t('common.save') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
