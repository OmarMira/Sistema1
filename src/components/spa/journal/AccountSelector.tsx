'use client';

import * as React from 'react';
import { Check, ChevronsUpDown, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useLanguageStore } from '@/store/language-store';

export interface GlAccountOption {
  id: string;
  code: string;
  name: string;
  accountType: string;
  normalBalance: string;
}

interface AccountSelectorProps {
  accounts: GlAccountOption[];
  value: string | null;
  onChange: (accountId: string | null) => void;
  placeholder?: string;
  disabled?: boolean;
}

const accountTypeColors: Record<string, string> = {
  asset: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  liability: 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300',
  equity: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  revenue: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  expense: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
};

const accountTypeLabels: Record<string, Record<string, string>> = {
  asset: { en: 'Asset', es: 'Activo' },
  liability: { en: 'Liability', es: 'Pasivo' },
  equity: { en: 'Equity', es: 'Capital' },
  revenue: { en: 'Revenue', es: 'Ingreso' },
  expense: { en: 'Expense', es: 'Gasto' },
};

export function AccountSelector({
  accounts,
  value,
  onChange,
  placeholder,
  disabled = false,
}: AccountSelectorProps) {
  const [open, setOpen] = React.useState(false);
  const t = useLanguageStore((s) => s.t);

  const selectedAccount = accounts.find((a) => a.id === value);

  // Group accounts by type
  const groupedAccounts = React.useMemo(() => {
    const groups: Record<string, GlAccountOption[]> = {};
    for (const account of accounts) {
      if (!groups[account.accountType]) {
        groups[account.accountType] = [];
      }
      groups[account.accountType].push(account);
    }
    return groups;
  }, [accounts]);

  const typeOrder = ['asset', 'liability', 'equity', 'revenue', 'expense'];

  const lang = useLanguageStore((s) => s.language);

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange(null);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn(
            'w-full justify-between font-normal h-9',
            !selectedAccount && 'text-muted-foreground',
            disabled && 'opacity-50 cursor-not-allowed'
          )}
          disabled={disabled}
        >
          {selectedAccount ? (
            <span className="flex items-center gap-2 truncate">
              <span className="font-mono text-xs text-teal-600 dark:text-teal-400 shrink-0">
                {selectedAccount.code}
              </span>
              <span className="truncate">{selectedAccount.name}</span>
            </span>
          ) : (
            <span className="truncate">
              {placeholder ?? t('journal.selectAccount')}
            </span>
          )}
          {selectedAccount && !disabled && (
            <X
              className="ml-1 size-3 shrink-0 opacity-50 hover:opacity-100"
              onClick={handleClear}
            />
          )}
          {!disabled && <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command>
          <CommandInput placeholder={`${t('common.search')}...`} />
          <CommandList className="max-h-[280px]">
            <CommandEmpty>{t('journal.noAccountsFound')}</CommandEmpty>
            {typeOrder.map((type) => {
              const group = groupedAccounts[type];
              if (!group || group.length === 0) return null;
              return (
                <CommandGroup
                  key={type}
                  heading={
                    <span className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={cn('text-[10px] px-1.5 py-0', accountTypeColors[type])}
                      >
                        {accountTypeLabels[type]?.[lang] ?? type}
                      </Badge>
                    </span>
                  }
                >
                  {group.map((account) => (
                    <CommandItem
                      key={account.id}
                      value={`${account.code} ${account.name}`}
                      onSelect={() => {
                        onChange(account.id === value ? null : account.id);
                        setOpen(false);
                      }}
                    >
                      <Check
                        className={cn(
                          'mr-2 size-4 shrink-0',
                          value === account.id ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                      <span className="font-mono text-xs text-teal-600 dark:text-teal-400 shrink-0 w-14 text-right mr-2">
                        {account.code}
                      </span>
                      <span className="truncate">{account.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
