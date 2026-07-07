'use client';

import { useState, useEffect } from 'react';
import { Loader2, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { AccountSelector, type GlAccountOption } from '@/components/spa/journal/AccountSelector';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useLanguageStore } from '@/store/language-store';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import entityRoles from '../../../rules/entity-roles.json';
import { ROLE_ACCOUNT_MAP } from '@/lib/constants/role-account-map';
import type { EntityRole } from '@/lib/constants/entity-roles';

const DEFAULT_ROLES = entityRoles;

interface ContextClarificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  pattern: string;
  companyId: string;
  onSuccess: (role: string, glAccountId?: string) => void;
}

export function ContextClarificationModal({
  isOpen,
  onClose,
  pattern,
  companyId,
  onSuccess,
}: ContextClarificationModalProps) {
  const t = useLanguageStore((s) => s.t);

  const [role, setRole] = useState<string>('PROVEEDOR');
  const [customRole, setCustomRole] = useState<string>('');
  const [accounts, setAccounts] = useState<GlAccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(false);

  // Conversational parsing state
  const [activeTab, setActiveTab] = useState<string>('conversational');
  const [userInput, setUserInput] = useState('');
  const [parsing, setParsing] = useState(false);

  // Fetch accounts
  useEffect(() => {
    if (!companyId || !isOpen) return;

    async function fetchAccounts() {
      setLoadingAccounts(true);
      try {
        const res = await fetch(`/api/journal/accounts?companyId=${companyId}`);
        if (res.ok) {
          const data = await res.json();
          const accs: GlAccountOption[] = data.data ?? data;
          setAccounts(accs);

          // Pre-select GL Account based on default role mapping
          const defaultCode = ROLE_ACCOUNT_MAP[role as EntityRole]?.fallback;
          if (defaultCode) {
            const matched = accs.find((a) => a.code === defaultCode);
            if (matched) {
              setSelectedAccountId(matched.id);
            }
          }
        }
      } catch (err) {
        logger.error('Error fetching accounts for context', { error: String(err) });
      } finally {
        setLoadingAccounts(false);
      }
    }

    fetchAccounts();
  }, [companyId, isOpen, role]);

  // Update selected account when role changes
  useEffect(() => {
    if (!accounts.length) return;
    const defaultCode = ROLE_ACCOUNT_MAP[role as EntityRole]?.fallback;
    if (defaultCode) {
      const matched = accounts.find((a) => a.code === defaultCode);
      if (matched) {
        setSelectedAccountId(matched.id);
      } else {
        setSelectedAccountId(null);
      }
    } else {
      setSelectedAccountId(null);
    }
  }, [role, accounts]);

  const handleConversationalParse = async () => {
    if (!userInput.trim()) return;
    setParsing(true);
    try {
      const res = await fetch('/api/learning/conversational-parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          pattern,
          userInput: userInput.trim(),
        }),
      });

      if (res.ok) {
        const result = await res.json();
        if (result.success && result.data) {
          const parsedData = result.data;

          // Set role
          const newRole = parsedData.role || 'PROVEEDOR';
          setRole(newRole);

          // Set account
          if (parsedData.glAccountId) {
            setSelectedAccountId(parsedData.glAccountId);
          } else if (parsedData.glAccountCode) {
            const matched = accounts.find((a) => a.code === parsedData.glAccountCode);
            if (matched) {
              setSelectedAccountId(matched.id);
            }
          }

          // Set custom role if OTRO
          if (!DEFAULT_ROLES.includes(newRole)) {
            setRole('OTRO');
            setCustomRole(newRole);
          }

          toast.success(
            t('learning.aiSuccess')
              .replace('{role}', newRole)
              .replace('{account}', parsedData.glAccountCode || ''),
          );

          // Switch to manual view so the user can verify
          setActiveTab('manual');
        }
      } else {
        const errBody = await res.json().catch(() => ({}));
        if (errBody.code === 'AI_NOT_CONFIGURED') {
          toast.error(t('learning.aiNotConfigured'));
        } else {
          toast.error(t('learning.aiError'));
        }
      }
    } catch (err) {
      logger.error('Error in conversational parsing', { error: String(err) });
      if ((err as Error & { code?: string }).code === 'AI_NOT_CONFIGURED') {
        toast.error(t('learning.aiNotConfigured'));
      } else {
        toast.error(t('learning.aiError'));
      }
    } finally {
      setParsing(false);
    }
  };

  const handleSave = async () => {
    const finalRole = role === 'OTRO' ? customRole.trim() : role;
    if (!finalRole) return;

    setSaving(true);
    try {
      const res = await fetch('/api/learning/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId,
          pattern,
          role: finalRole,
          glAccountId: selectedAccountId,
        }),
      });

      if (res.ok) {
        onSuccess(finalRole, selectedAccountId || undefined);
        onClose();
      }
    } catch (err) {
      logger.error('Error saving context', { error: String(err) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <div className="p-1.5 rounded-lg bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400">
              <HelpCircle className="size-5" />
            </div>
            <DialogTitle className="text-xl">{t('learning.modalTitle')}</DialogTitle>
          </div>
          <DialogDescription className="text-sm">
            {t('learning.modalDesc').replace('{pattern}', pattern)}
          </DialogDescription>
        </DialogHeader>

        <div className="py-3">
          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="grid w-full grid-cols-2 mb-4">
              <TabsTrigger value="conversational">{t('learning.tabConversational')}</TabsTrigger>
              <TabsTrigger value="manual">{t('learning.tabManual')}</TabsTrigger>
            </TabsList>

            <TabsContent value="conversational" className="space-y-4 py-2">
              <div className="space-y-2">
                <Label htmlFor="user-input">{t('learning.promptLabel')}</Label>
                <Textarea
                  id="user-input"
                  value={userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  placeholder={t('learning.promptPlaceholder')}
                  className="min-h-[100px] resize-none"
                />
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={handleConversationalParse}
                disabled={parsing || !userInput.trim()}
                className="w-full gap-2 border-violet-200 text-violet-700 hover:bg-violet-50 dark:border-violet-900/30 dark:text-violet-400 dark:hover:bg-violet-950/20"
              >
                {parsing ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('learning.analyzing')}
                  </>
                ) : (
                  <>
                    <HelpCircle className="size-4" />
                    {t('learning.analyzeBtn')}
                  </>
                )}
              </Button>
            </TabsContent>

            <TabsContent value="manual" className="space-y-4 py-2">
              {/* Role selector */}
              <div className="space-y-2">
                <Label htmlFor="role-select">{t('learning.roleLabel')}</Label>
                <Select value={role} onValueChange={setRole}>
                  <SelectTrigger id="role-select">
                    <SelectValue placeholder={t('learning.rolePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    {DEFAULT_ROLES.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r === 'INQUILINO'
                          ? t('learning.roleTenant')
                          : r === 'PROVEEDOR'
                            ? t('learning.roleVendor')
                            : r === 'SOCIO'
                              ? t('learning.rolePartner')
                              : r === 'CLIENTE'
                                ? t('learning.roleCustomer')
                                : t('learning.roleEmployee')}
                      </SelectItem>
                    ))}
                    <SelectItem value="OTRO">{t('learning.roleOther')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Custom Role Input */}
              {role === 'OTRO' && (
                <div className="space-y-2">
                  <Label htmlFor="custom-role">{t('learning.customRoleLabel')}</Label>
                  <Input
                    id="custom-role"
                    value={customRole}
                    onChange={(e) => setCustomRole(e.target.value)}
                    placeholder={t('learning.customRolePlaceholder')}
                  />
                </div>
              )}

              {/* Suggested GL Account */}
              <div className="space-y-2">
                <Label>{t('learning.accountLabel')}</Label>
                {loadingAccounts ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="size-4 animate-spin text-violet-500" />
                    <span>{t('learning.loadingAccounts')}</span>
                  </div>
                ) : (
                  <AccountSelector
                    accounts={accounts}
                    value={selectedAccountId}
                    onChange={setSelectedAccountId}
                    placeholder={t('learning.accountPlaceholder')}
                  />
                )}
                <p className="text-xs text-muted-foreground">{t('learning.accountDesc')}</p>
              </div>
            </TabsContent>
          </Tabs>
        </div>

        <DialogFooter className="gap-2 sm:gap-0 mt-4">
          <Button variant="outline" onClick={onClose} disabled={saving || parsing}>
            {t('learning.cancelBtn')}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || parsing || (role === 'OTRO' && !customRole.trim())}
            className="gap-2 bg-violet-600 hover:bg-violet-700 text-white"
          >
            {saving && <Loader2 className="size-4 animate-spin" />}
            {t('learning.confirmBtn')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
