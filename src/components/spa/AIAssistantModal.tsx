'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles, MessageSquare, FilePlus2 } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { cn } from '@/lib/utils';
import { ChatView } from '@/components/assistant/ChatView';
import { RuleView } from '@/components/assistant/RuleView';
import type { AssistantMode, ChatMessage, ParsedRule, HistoryEntry } from '@/lib/types/ai-assistant';
import { overlayVariants, modalVariants } from '@/lib/types/ai-assistant';

/* ─── Component ───────────────────────────────────────────────────── */
export function AIAssistantModal() {
  const t = useLanguageStore((s) => s.t);
  const activeCompany = useAuthStore((s) => s.activeCompany);
  const aiAssistantOpen = useAuthStore((s) => s.aiAssistantOpen);
  const setAiAssistantOpen = useAuthStore((s) => s.setAiAssistantOpen);

  const [mode, setMode] = useState<AssistantMode>('chat');
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [ruleInput, setRuleInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [parsedRule, setParsedRule] = useState<ParsedRule | null>(null);
  const [error, setError] = useState('');

  // Conversational rule builder state
  const [ruleMessages, setRuleMessages] = useState<ChatMessage[]>([]);
  const [ruleHistory, setRuleHistory] = useState<HistoryEntry[]>([]);
  const [ruleIsComplete, setRuleIsComplete] = useState(false);

  // Interactive Account Creation Wizard state
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardCode, setWizardCode] = useState('');
  const [wizardName, setWizardName] = useState('');
  const [wizardParentId, setWizardParentId] = useState('');

  // List of accounts for form selectors
  const [accounts, setAccounts] = useState<{ id: string; name: string; code: string }[]>([]);

  // Fetch accounts on assistant mount / open
  useEffect(() => {
    if (aiAssistantOpen && activeCompany) {
      fetch(`/api/accounts?companyId=${activeCompany.id}`)
        .then((res) => {
          if (!res.ok) throw new Error();
          return res.json();
        })
        .then((data) => {
          const accs = data.accounts ?? data.data ?? data ?? [];
          setAccounts(accs);
        })
        .catch(() => {});
    }
  }, [aiAssistantOpen, activeCompany]);

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const ruleInputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll chat messages
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages, wizardOpen]);

  // Reset to chat mode and clear history when opening
  useEffect(() => {
    if (aiAssistantOpen) {
      setMode('chat');
      setError('');
      setChatMessages([]);
      setChatInput('');
      setRuleInput('');
      setParsedRule(null);
      setRuleMessages([]);
      setRuleHistory([]);
      setRuleIsComplete(false);
      setWizardOpen(false);
      setWizardCode('');
      setWizardName('');
      setWizardParentId('');

      // Background LLM warmup call to wake up the serverless/API connection
      if (activeCompany) {
        fetch('/api/ai-assistant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: 'Hola',
            mode: 'chat',
            companyId: activeCompany.id,
            isWarmup: true,
          }),
        }).catch(() => {});
      }

      setTimeout(() => {
        chatInputRef.current?.focus();
      }, 300);
    }
  }, [aiAssistantOpen, activeCompany]);

  const handleStartWizard = async () => {
    if (!activeCompany) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/accounts?companyId=${activeCompany.id}`);
      if (!res.ok) throw new Error('Error al obtener el plan de cuentas');
      const data = await res.json();
      const accounts = data.accounts ?? [];

      // Find cash & cash equivalents (parent account "1010")
      const parentAcc = accounts.find((a: { code: string; id: string }) => a.code === '1010');
      if (!parentAcc) {
        throw new Error('No se encontró la cuenta base "1010 - Cash & Cash Equivalents"');
      }
      setWizardParentId(parentAcc.id);

      // Find sub-accounts of 1010 or starting with 101
      const subAccounts = accounts.filter(
        (a: { parentId: string; code: string }) => a.parentId === parentAcc.id || (a.code.startsWith('101') && a.code !== '1010'),
      );
      let nextCode = 1011;
      const codes = subAccounts.map((a: { code: string }) => parseInt(a.code, 10)).filter((c: number) => !isNaN(c));
      if (codes.length > 0) {
        nextCode = Math.max(...codes) + 1;
      }
      setWizardCode(String(nextCode));
      setWizardName('Banco Chase - Corriente 1234');
      setWizardOpen(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveWizardAccount = async () => {
    if (!wizardCode || !wizardName || !activeCompany) return;
    setIsLoading(true);
    setError('');
    try {
      const res = await fetch('/api/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany.id,
          code: wizardCode.trim(),
          name: wizardName.trim(),
          accountType: 'asset',
          normalBalance: 'debit',
          parentId: wizardParentId || null,
        }),
      });

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || 'No se pudo crear la cuenta contable');
      }

      setWizardOpen(false);

      const successMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `✅ ¡Listo! He creado la cuenta contable **"${wizardCode} - ${wizardName}"** de tipo Activo (Deudor) bajo **"1010 - Cash & Cash Equivalents"** en tu Plan de Cuentas.`,
        timestamp: new Date(),
      };
      setChatMessages((prev) => [...prev, successMsg]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && aiAssistantOpen) {
        setAiAssistantOpen(false);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [aiAssistantOpen, setAiAssistantOpen]);

  /* ─── Chat Submit ─────────────────────────────────────────────── */
  const handleChatSubmit = useCallback(async () => {
    const trimmed = chatInput.trim();
    if (!trimmed || isLoading) return;

    setError('');
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      timestamp: new Date(),
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/ai-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, mode: 'chat', companyId: activeCompany?.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        const code = data.code as string | undefined;
        const errorMsg =
          code === 'AI_NOT_CONFIGURED'
            ? t('aiAssistant.errorNotConfigured')
            : code === 'AI_REQUEST_FAILED'
              ? t('aiAssistant.errorRequestFailed')
              : data.error || t('aiAssistant.error');
        setError(errorMsg);
        return;
      }

      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: data.reply || '...',
        timestamp: new Date(),
      };
      setChatMessages((prev) => [...prev, assistantMsg]);
    } catch {
      setError(t('aiAssistant.error'));
    } finally {
      setIsLoading(false);
      chatInputRef.current?.focus();
    }
  }, [chatInput, isLoading, t, activeCompany]);

  /* ─── Rule Submit (conversational) ───────────────────────────── */
  const handleRuleSubmit = useCallback(async () => {
    const trimmed = ruleInput.trim();
    if (!trimmed || isLoading) return;

    setError('');
    setIsLoading(true);

    // Add user message to conversation
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: trimmed,
      timestamp: new Date(),
    };
    setRuleMessages((prev) => [...prev, userMsg]);
    setRuleInput('');

    // Build updated history
    const updatedHistory: HistoryEntry[] = [...ruleHistory, { role: 'user', content: trimmed }];

    try {
      const res = await fetch('/api/ai-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: trimmed,
          mode: 'create-rule',
          companyId: activeCompany?.id,
          history: ruleHistory, // send previous history (not including this message, backend appends it)
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        const code = data.code as string | undefined;
        const errorMsg =
          code === 'AI_NOT_CONFIGURED'
            ? t('aiAssistant.errorNotConfigured')
            : code === 'AI_REQUEST_FAILED'
              ? t('aiAssistant.errorRequestFailed')
              : data.error || t('aiAssistant.error');
        setError(errorMsg);
        setIsLoading(false);
        return;
      }

      const assistantContent = data.reply || '...';
      const assistantMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: assistantContent,
        timestamp: new Date(),
      };
      setRuleMessages((prev) => [...prev, assistantMsg]);

      // Update history with both turns
      const assistantContentForHistory = data.rawJson || assistantContent;
      const newHistory: HistoryEntry[] = [
        ...updatedHistory,
        { role: 'assistant', content: assistantContentForHistory },
      ];
      setRuleHistory(newHistory);

      // Handle isComplete
      if (data.isComplete && data.parsedRule) {
        setParsedRule(data.parsedRule);
        setRuleIsComplete(true);
      } else {
        setParsedRule(null);
        setRuleIsComplete(false);
      }
    } catch {
      setError(t('aiAssistant.error'));
    } finally {
      setIsLoading(false);
    }
  }, [ruleInput, isLoading, t, activeCompany, ruleHistory]);

  /* ─── Save Rule (V2) ──────────────────────────────────────────── */
  const handleSaveRule = useCallback(async () => {
    if (!parsedRule || !activeCompany) return;

    setIsLoading(true);
    setError('');

    try {
      const accountsRes = await fetch(`/api/accounts?companyId=${activeCompany.id}`);
      if (!accountsRes.ok) {
        setError(t('aiAssistant.error'));
        setIsLoading(false);
        return;
      }

      const accountsData = await accountsRes.json();
      const accounts: { id: string; name: string }[] =
        accountsData.accounts ?? accountsData.data ?? accountsData ?? [];

      const findAccount = (name: string) =>
        accounts.find((a) => a.name.toLowerCase() === name.toLowerCase());

      // Resolve GL account IDs
      let glAccountId: string | undefined;
      let debitGlAccountId: string | undefined;
      let creditGlAccountId: string | undefined;

      if (parsedRule.glAccountName) {
        const acc = findAccount(parsedRule.glAccountName);
        if (!acc) {
          setError(`No se encontró la cuenta "${parsedRule.glAccountName}".`);
          setIsLoading(false);
          return;
        }
        glAccountId = acc.id;
      }

      if (parsedRule.debitGlAccountName) {
        const acc = findAccount(parsedRule.debitGlAccountName);
        if (!acc) {
          setError(`No se encontró la cuenta de débito "${parsedRule.debitGlAccountName}".`);
          setIsLoading(false);
          return;
        }
        debitGlAccountId = acc.id;
      }

      if (parsedRule.creditGlAccountName) {
        const acc = findAccount(parsedRule.creditGlAccountName);
        if (!acc) {
          setError(`No se encontró la cuenta de crédito "${parsedRule.creditGlAccountName}".`);
          setIsLoading(false);
          return;
        }
        creditGlAccountId = acc.id;
      }

      // Build conditions for V2 (use first condition for legacy fields as fallback)
      const firstCondition = parsedRule.conditions?.[0];

      const ruleRes = await fetch('/api/bank-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany.id,
          name: parsedRule.name,
          // V2 fields
          conditions: parsedRule.conditions,
          debitGlAccountId,
          creditGlAccountId,
          // Legacy / fallback
          conditionType: parsedRule.conditionType ?? firstCondition?.operator ?? 'contains',
          conditionValue: parsedRule.conditionValue ?? String(firstCondition?.value ?? ''),
          transactionDirection: parsedRule.transactionDirection,
          glAccountId: glAccountId ?? debitGlAccountId ?? creditGlAccountId,
          priority: parsedRule.priority,
          isActive: true,
        }),
      });

      if (ruleRes.ok || ruleRes.status === 201) {
        const successMsg: ChatMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: `✅ ¡Regla "${parsedRule.name}" creada exitosamente! Ya está activa y clasificará transacciones automáticamente.`,
          timestamp: new Date(),
        };
        setRuleMessages((prev) => [...prev, successMsg]);
        setParsedRule(null);
        setRuleIsComplete(false);
        setRuleHistory([]);
      } else {
        const errData = await ruleRes.json();
        let errorMsg = errData.error || t('aiAssistant.error');
        if (errorMsg === 'A rule with identical conditions and direction already exists.') {
          errorMsg = t('bankRules.duplicateRuleError');
        }
        setError(errorMsg);
      }
    } catch {
      setError(t('aiAssistant.error'));
    } finally {
      setIsLoading(false);
    }
  }, [parsedRule, activeCompany, t]);

  /* ─── Key Handlers ────────────────────────────────────────────── */
  const handleChatKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleChatSubmit();
    }
  };

  const handleRuleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleRuleSubmit();
    }
  };

  /* ─── Render ──────────────────────────────────────────────────── */
  return (
    <AnimatePresence>
      {aiAssistantOpen && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center p-4"
          variants={overlayVariants}
          initial="hidden"
          animate="visible"
          exit="exit"
        >
          {/* Backdrop */}
          <motion.div
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            onClick={() => setAiAssistantOpen(false)}
          />

          {/* Modal */}
          <motion.div
            className="relative z-10 flex w-[90%] max-w-4xl max-h-[90vh] h-[800px] flex-col overflow-hidden rounded-2xl shadow-2xl"
            style={{ backgroundColor: '#1a2332' }}
            variants={modalVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={(e) => e.stopPropagation()}
          >
            {/* ── Header ── */}
            <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-purple-600/20">
                  <Sparkles className="size-5 text-purple-400" />
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-white">{t('aiAssistant.title')}</h2>
                  <p className="text-xs text-slate-400">
                    {activeCompany?.legalName ?? 'AccountExpress'}{' '}
                    <span className="text-slate-500">·</span>{' '}
                    <span className="text-slate-500">{activeCompany?.taxId ?? ''}</span>
                  </p>
                </div>
              </div>

              {/* Mode Tabs */}
              <div className="flex items-center gap-2">
                <div className="flex rounded-lg bg-white/5 p-1">
                  <button
                    onClick={() => {
                      setMode('chat');
                      setError('');
                    }}
                    onDoubleClick={() => {
                      setMode('chat');
                      setError('');
                      setChatMessages([]);
                      setChatInput('');
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      mode === 'chat'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white',
                    )}
                  >
                    <MessageSquare className="size-3.5" />
                    <span className="hidden sm:inline">{t('aiAssistant.chat')}</span>
                  </button>
                  <button
                    onClick={() => {
                      setMode('create-rule');
                      setError('');
                      setTimeout(() => ruleInputRef.current?.focus(), 100);
                    }}
                    onDoubleClick={() => {
                      setMode('create-rule');
                      setError('');
                      setRuleInput('');
                      setParsedRule(null);
                      setRuleMessages([]);
                      setRuleHistory([]);
                      setRuleIsComplete(false);
                      setTimeout(() => ruleInputRef.current?.focus(), 100);
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      mode === 'create-rule'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white',
                    )}
                  >
                    <FilePlus2 className="size-3.5" />
                    <span className="hidden sm:inline">{t('aiAssistant.createRule')}</span>
                  </button>
                </div>

                <button
                  onClick={() => setAiAssistantOpen(false)}
                  className="ml-2 flex size-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <X className="size-5" />
                </button>
              </div>
            </div>

            {/* ── Content ── */}
            <div className="flex flex-1 flex-col overflow-hidden">
              {mode === 'chat' ? (
                <ChatView
                  messages={chatMessages}
                  isLoading={isLoading}
                  error={error}
                  chatInput={chatInput}
                  setChatInput={setChatInput}
                  handleChatSubmit={handleChatSubmit}
                  handleChatKeyDown={handleChatKeyDown}
                  chatScrollRef={chatScrollRef}
                  chatInputRef={chatInputRef}
                  handleStartWizard={handleStartWizard}
                  wizardOpen={wizardOpen}
                  setWizardOpen={setWizardOpen}
                  wizardCode={wizardCode}
                  setWizardCode={setWizardCode}
                  wizardName={wizardName}
                  setWizardName={setWizardName}
                  handleSaveWizardAccount={handleSaveWizardAccount}
                />
              ) : (
                <RuleView
                  isLoading={isLoading}
                  error={error}
                  ruleInput={ruleInput}
                  setRuleInput={setRuleInput}
                  handleRuleSubmit={handleRuleSubmit}
                  handleRuleKeyDown={handleRuleKeyDown}
                  ruleInputRef={ruleInputRef}
                  parsedRule={parsedRule}
                  setParsedRule={setParsedRule}
                  accounts={accounts}
                  ruleMessages={ruleMessages}
                  ruleIsComplete={ruleIsComplete}
                  handleSaveRule={handleSaveRule}
                />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}


