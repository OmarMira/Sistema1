'use client';

import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AccountGuidance, GuidanceAccount } from '@/lib/services/entity-account-guidance';

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface Props {
  guidance?: AccountGuidance;
  accounts: GuidanceAccount[];
  selectedCode: string;
  locale: string;
  rentReceipt: boolean;
  clarification: string;
  onClarify: (value: string) => void;
  onSelect: (code: string) => void;
  onCreated: (account: GuidanceAccount) => void;
  onBusyChange: (busy: boolean) => void;
  t: Translate;
}

export function EntityAccountGuidance({ guidance, accounts, selectedCode, locale, rentReceipt, clarification, onClarify, onSelect, onCreated, onBusyChange, t }: Props) {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const parent = accounts.find((account) => account.code === (selectedCode || guidance?.account?.code));
  let suffix = 1;
  while (parent && accounts.some((account) => account.code === `${parent.code}-${String(suffix).padStart(2, '0')}`)) suffix++;
  const childCode = parent ? `${parent.code}-${String(suffix).padStart(2, '0')}` : '';
  const canCreate = parent && ['debit', 'credit'].includes(parent.normalBalance) && !!parent.accountType;

  async function createChild() {
    if (!parent || !canCreate || !name.trim() || saving) return;
    setSaving(true);
    onBusyChange(true);
    setError('');
    try {
      const response = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-locale': locale },
        body: JSON.stringify({
          code: childCode, name: name.trim(), accountType: parent.accountType,
          normalBalance: parent.normalBalance, parentId: parent.id,
        }),
      });
      if (!mounted.current) return;
      if (!response.ok) {
        setError(t(response.status === 409 ? 'learning.accountGuidance.codeConflict' : 'learning.accountGuidance.createError'));
        return;
      }
      const { account } = await response.json();
      if (!mounted.current) return;
      onCreated(account);
      onSelect(account.code);
      setCreating(false);
      setName('');
    } catch {
      if (mounted.current) setError(t('learning.accountGuidance.createError'));
    } finally {
      onBusyChange(false);
      if (mounted.current) setSaving(false);
    }
  }

  return (
    <div className="border-t mt-3 pt-3 space-y-3">
      {guidance?.needsClarification && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{guidance.question || t('learning.accountGuidance.clarification')}</p>
          <Input
            aria-label={t('learning.accountGuidance.clarification')}
            placeholder={t('learning.accountGuidance.clarificationPlaceholder')}
            value={clarification}
            onChange={(event) => onClarify(event.target.value)}
            data-testid="guidance-clarification"
          />
        </div>
      )}
      {guidance?.account && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('learning.accountGuidance.title')}: {guidance.account.code} — {guidance.account.name}</p>
          {guidance.reason && <p className="text-sm text-muted-foreground">{guidance.reason}</p>}
          {guidance.intent && <p className="text-sm">{t(rentReceipt && guidance.intent === 'RENT_PAYMENT' ? 'learning.rentReceipt' : `transactionIntent.${guidance.intent}`)}</p>}
          <Button type="button" size="sm" variant="outline" data-testid="use-suggested-account" disabled={saving} onClick={() => onSelect(guidance.account!.code)}>
            {t('learning.accountGuidance.useSuggested')}
          </Button>
        </div>
      )}
      <label className="block text-xs text-muted-foreground">{t('learning.accountGuidance.chooseExisting')}
        <Select value={selectedCode} onValueChange={onSelect} disabled={saving}>
          <SelectTrigger data-testid="guidance-account-select" className="mt-1"><SelectValue placeholder={t('learning.accountPlaceholder')} /></SelectTrigger>
          <SelectContent>{accounts.map((account) => <SelectItem key={account.id} value={account.code}>{account.code} — {account.name}</SelectItem>)}</SelectContent>
        </Select>
      </label>
      {canCreate && !creating && (
        <Button type="button" variant="outline" size="sm" data-testid="create-subaccount-btn" onClick={() => setCreating(true)}>{t('learning.accountGuidance.createChild')}</Button>
      )}
      {creating && parent && (
        <div className="space-y-2 rounded border p-3">
          <p className="text-sm">{parent.name} → {childCode}{name.trim() ? ` — ${name.trim()}` : ''}</p>
          <Input aria-label={t('learning.accountGuidance.childName')} data-testid="subaccount-name" value={name} onChange={(event) => setName(event.target.value)} disabled={saving} />
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" data-testid="confirm-subaccount-btn" onClick={createChild} disabled={saving || !name.trim()}>{t('learning.accountGuidance.confirmCreate')}</Button>
            <Button type="button" size="sm" variant="ghost" data-testid="cancel-subaccount-btn" disabled={saving} onClick={() => { setCreating(false); setError(''); }}>{t('learning.accountGuidance.cancel')}</Button>
          </div>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">{t('learning.accountGuidance.caution')}</p>
    </div>
  );
}
