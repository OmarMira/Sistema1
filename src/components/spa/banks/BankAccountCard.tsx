'use client';

import { Landmark, Eye, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useLanguageStore } from '@/store/language-store';
import { maskAccountNo, fmtCurrency } from './bank-utils';

interface GlAccountInfo {
  id: string;
  code: string;
  name: string;
  accountType: string;
}

interface BankAccountData {
  id: string;
  companyId: string;
  accountName: string;
  bankName: string;
  accountNo: string | null;
  routingNo: string | null;
  glAccountId: string;
  balance: number;
  initialBalance: number;
  currency: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  glAccount: GlAccountInfo;
  _count: { statements: number };
}

interface BankAccountCardProps {
  account: BankAccountData;
  variant: 'active' | 'inactive';
  onView?: (account: BankAccountData) => void;
  onEdit: (account: BankAccountData) => void;
  onDelete?: (account: BankAccountData) => void;
  onSelect: (account: BankAccountData) => void;
}

export function BankAccountCard({
  account,
  variant,
  onView,
  onEdit,
  onDelete,
  onSelect,
}: BankAccountCardProps) {
  const t = useLanguageStore((s) => s.t);
  const isActive = variant === 'active';

  return (
    <div
      className={`rounded-lg border bg-card p-4 shadow-sm hover:shadow-md transition-all cursor-pointer relative ${
        isActive
          ? 'border-l-4 border-l-teal-500 hover:border-l-teal-600'
          : 'border-l-4 border-l-gray-400 opacity-60'
      }`}
      onClick={() => onSelect(account)}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div
            className={`p-2 rounded-xl ${
              isActive
                ? 'bg-teal-50 dark:bg-teal-900/30'
                : 'bg-gray-50 dark:bg-gray-800'
            }`}
          >
            <Landmark
              className={`size-5 ${
                isActive
                  ? 'text-teal-600 dark:text-teal-400'
                  : 'text-gray-400 dark:text-gray-500'
              }`}
            />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">
              {account.accountName}
            </h3>
            <p className="text-xs text-muted-foreground">
              {account.bankName} · {maskAccountNo(account.accountNo)}
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            {isActive ? t('banks.currentBalance') : t('banks.balance')}
          </p>
          {isActive ? (
            <p
              className={`text-lg font-bold font-mono ${
                account.balance >= 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {fmtCurrency(account.balance)}
            </p>
          ) : (
            <p className="text-sm font-mono text-muted-foreground">
              {fmtCurrency(account.balance)}
            </p>
          )}
        </div>
        {isActive && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={(e) => {
                e.stopPropagation();
                onView?.(account);
              }}
              title={t('common.view')}
            >
              <Eye className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={(e) => {
                e.stopPropagation();
                onEdit(account);
              }}
              title={t('common.edit')}
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-red-500 hover:text-red-600"
              onClick={(e) => {
                e.stopPropagation();
                onDelete?.(account);
              }}
              title={t('common.delete')}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}
        {!isActive && (
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={(e) => {
              e.stopPropagation();
              onEdit(account);
            }}
          >
            <Pencil className="size-3.5 mr-1" />
            {t('common.edit')}
          </Button>
        )}
      </div>

      {isActive && (
        <div className="flex items-center gap-3 mt-2 pt-2 border-t text-[11px] text-muted-foreground">
          <span className="font-mono">{maskAccountNo(account.accountNo)}</span>
          <span>{account.currency}</span>
          <span className="font-mono text-teal-600 dark:text-teal-400">
            {account.glAccount.code}
          </span>
        </div>
      )}
    </div>
  );
}
