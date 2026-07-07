'use client';

import { ArrowLeft, Landmark, Pencil, CheckCircle2, XCircle, CircleDot } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useLanguageStore } from '@/store/language-store';
import { maskAccountNo, fmtCurrency, formatDate, formatDateShort } from './bank-utils';

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

interface BankTransactionData {
  id: string;
  date: string;
  description: string;
  amount: number;
  reference: string | null;
  isReconciled: boolean;
  glAccountId: string | null;
  glAccount: GlAccountInfo | null;
}

interface BankDetailViewProps {
  account: BankAccountData;
  transactions: BankTransactionData[];
  onBack: () => void;
  onEdit: (account: BankAccountData) => void;
}

export function BankDetailView({
  account,
  transactions,
  onBack,
  onEdit,
}: BankDetailViewProps) {
  const t = useLanguageStore((s) => s.t);

  return (
    <div className="space-y-4">
      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="size-4 mr-1" />
        {t('common.back')}
      </Button>

      {/* Account Detail Card */}
      <div className="rounded-lg border bg-card p-6">
        <div className="flex items-start justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-50 dark:bg-blue-900/30">
              <Landmark className="size-6 text-blue-600 dark:text-blue-400" />
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900 dark:text-gray-100">
                {account.accountName}
              </h2>
              <p className="text-sm text-muted-foreground">
                {account.bankName} · {maskAccountNo(account.accountNo)}
              </p>
            </div>
          </div>
          <Badge variant="outline" className="text-xs">
            {account.currency}
          </Badge>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t('banks.currentBalance')}</p>
            <p className={`text-lg font-bold font-mono ${account.balance >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
              {fmtCurrency(account.balance)}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t('banks.linkedAccount')}</p>
            <p className="text-sm font-medium">
              <span className="font-mono text-xs text-teal-600 dark:text-teal-400 mr-1">
                {account.glAccount.code}
              </span>
              {account.glAccount.name}
            </p>
          </div>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t('banks.statements')}</p>
            <p className="text-sm font-medium">{account._count.statements}</p>
          </div>
          <div className="space-y-1 flex flex-col items-end">
            <Button variant="outline" size="sm" onClick={() => onEdit(account)}>
              <Pencil className="size-3.5 mr-1" />
              {t('common.edit')}
            </Button>
          </div>
        </div>
      </div>

      {/* Transactions Card */}
      <div className="rounded-lg border bg-card p-6">
        <h3 className="text-base font-semibold mb-4">{t('banks.recentTransactions')}</h3>
        {transactions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <CircleDot className="size-8 text-muted-foreground/40 mb-2" />
            <p className="text-sm text-muted-foreground">{t('banks.noTransactions')}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('common.date')}</TableHead>
                <TableHead>{t('common.description')}</TableHead>
                <TableHead className="text-right">{t('common.amount')}</TableHead>
                <TableHead className="text-center">{t('common.status')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.map((tx) => (
                <TableRow key={tx.id}>
                  <TableCell className="text-sm">{formatDateShort(tx.date)}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{tx.description}</span>
                      {tx.glAccount && (
                        <span className="text-[10px] font-mono text-muted-foreground px-1.5 py-0.5 bg-muted rounded">
                          {tx.glAccount.code}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className={`text-right font-mono text-sm font-medium ${tx.amount < 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                    {fmtCurrency(tx.amount)}
                  </TableCell>
                  <TableCell className="text-center">
                    {tx.isReconciled ? (
                      <CheckCircle2 className="size-4 text-emerald-500 mx-auto" />
                    ) : (
                      <XCircle className="size-4 text-muted-foreground/50 mx-auto" />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
