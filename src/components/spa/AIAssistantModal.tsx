'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  X,
  Send,
  Bot,
  Sparkles,
  MessageSquare,
  FilePlus2,
  Loader2,
  Save,
  AlertCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuthStore } from '@/store/auth-store';
import { useLanguageStore } from '@/store/language-store';
import { cn } from '@/lib/utils';

/* ─── Types ───────────────────────────────────────────────────────── */
type AssistantMode = 'chat' | 'create-rule';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface ParsedRule {
  name: string;
  conditionType: string;
  conditionValue: string;
  transactionDirection: string;
  glAccountName: string;
  priority: number;
}

/* ─── Animation Variants ──────────────────────────────────────────── */
const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const modalVariants = {
  hidden: { opacity: 0, scale: 0.92, y: 20 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 300, damping: 30 },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 10,
    transition: { duration: 0.15 },
  },
};

const messageVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2 } },
};

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
  const [ruleReply, setRuleReply] = useState('');
  const [error, setError] = useState('');

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  const ruleInputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll chat messages
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [chatMessages]);

  // Reset to chat mode when opening
  useEffect(() => {
    if (aiAssistantOpen) {
      setMode('chat');
      setError('');
      setTimeout(() => {
        chatInputRef.current?.focus();
      }, 300);
    }
  }, [aiAssistantOpen]);

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
        body: JSON.stringify({ message: trimmed, mode: 'chat' }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t('aiAssistant.error'));
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
  }, [chatInput, isLoading, t]);

  /* ─── Rule Submit ─────────────────────────────────────────────── */
  const handleRuleSubmit = useCallback(async () => {
    const trimmed = ruleInput.trim();
    if (!trimmed || isLoading) return;

    setError('');
    setParsedRule(null);
    setRuleReply('');
    setIsLoading(true);

    try {
      const res = await fetch('/api/ai-assistant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, mode: 'create-rule' }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || t('aiAssistant.error'));
        return;
      }

      setRuleReply(data.reply || '');
      if (data.parsedRule) {
        setParsedRule(data.parsedRule);
      }
    } catch {
      setError(t('aiAssistant.error'));
    } finally {
      setIsLoading(false);
    }
  }, [ruleInput, isLoading, t]);

  /* ─── Save Rule ───────────────────────────────────────────────── */
  const handleSaveRule = useCallback(async () => {
    if (!parsedRule || !activeCompany) return;

    setIsLoading(true);
    setError('');

    try {
      // First, find the GL account by name
      const accountsRes = await fetch(
        `/api/accounts?companyId=${activeCompany.id}`
      );
      if (!accountsRes.ok) {
        setError(t('aiAssistant.error'));
        setIsLoading(false);
        return;
      }

      const accountsData = await accountsRes.json();
      const accounts = accountsData.data ?? accountsData ?? [];
      const glAccount = accounts.find(
        (a: { name: string }) =>
          a.name.toLowerCase() === parsedRule.glAccountName.toLowerCase()
      );

      if (!glAccount) {
        setError(
          `No se encontró la cuenta "${parsedRule.glAccountName}". Por favor, verifica el nombre en tu Plan de Cuentas.`
        );
        setIsLoading(false);
        return;
      }

      // Create the rule via bank-rules API
      const ruleRes = await fetch('/api/bank-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyId: activeCompany.id,
          name: parsedRule.name,
          conditionType: parsedRule.conditionType,
          conditionValue: parsedRule.conditionValue,
          transactionDirection: parsedRule.transactionDirection,
          glAccountId: glAccount.id,
          priority: parsedRule.priority,
          isActive: true,
        }),
      });

      if (ruleRes.ok || ruleRes.status === 201) {
        setParsedRule(null);
        setRuleInput('');
        setRuleReply(t('aiAssistant.ruleCreated'));
      } else {
        const errData = await ruleRes.json();
        setError(errData.error || t('aiAssistant.error'));
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
            className="relative z-10 flex w-[90%] max-w-4xl flex-col overflow-hidden rounded-2xl shadow-2xl"
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
                  <h2 className="text-lg font-semibold text-white">
                    {t('aiAssistant.title')}
                  </h2>
                  <p className="text-xs text-slate-400">
                    {activeCompany?.legalName ?? 'AccountExpress'}{' '}
                    <span className="text-slate-500">·</span>{' '}
                    <span className="text-slate-500">
                      {activeCompany?.taxId ?? ''}
                    </span>
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
                    className={cn(
                      'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      mode === 'chat'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    )}
                  >
                    <MessageSquare className="size-3.5" />
                    <span className="hidden sm:inline">
                      {t('aiAssistant.chat')}
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setMode('create-rule');
                      setError('');
                      setTimeout(() => ruleInputRef.current?.focus(), 100);
                    }}
                    className={cn(
                      'flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                      mode === 'create-rule'
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-400 hover:text-white'
                    )}
                  >
                    <FilePlus2 className="size-3.5" />
                    <span className="hidden sm:inline">
                      {t('aiAssistant.createRule')}
                    </span>
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
                  t={t}
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
                  ruleReply={ruleReply}
                  handleSaveRule={handleSaveRule}
                  t={t}
                />
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/* ─── Chat View ───────────────────────────────────────────────────── */
function ChatView({
  messages,
  isLoading,
  error,
  chatInput,
  setChatInput,
  handleChatSubmit,
  handleChatKeyDown,
  chatScrollRef,
  chatInputRef,
  t,
}: {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string;
  chatInput: string;
  setChatInput: (v: string) => void;
  handleChatSubmit: () => void;
  handleChatKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
  chatInputRef: React.RefObject<HTMLTextAreaElement | null>;
  t: (key: string) => string;
}) {
  const hasMessages = messages.length > 0;

  return (
    <>
      {/* Chat Messages or Welcome */}
      <div
        ref={chatScrollRef}
        className="flex-1 overflow-y-auto px-6 py-4"
      >
        {hasMessages ? (
          <div className="space-y-4">
            <AnimatePresence>
              {messages.map((msg) => (
                <motion.div
                  key={msg.id}
                  variants={messageVariants}
                  initial="hidden"
                  animate="visible"
                  className={cn(
                    'flex gap-3',
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  )}
                >
                  {msg.role === 'assistant' && (
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-600/20 mt-0.5">
                      <Bot className="size-4 text-blue-400" />
                    </div>
                  )}
                  <div
                    className={cn(
                      'max-w-[80%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap',
                      msg.role === 'user'
                        ? 'bg-blue-600 text-white rounded-br-md'
                        : 'bg-white/10 text-slate-200 rounded-bl-md'
                    )}
                  >
                    {msg.content}
                  </div>
                  {msg.role === 'user' && (
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-purple-600/20 mt-0.5">
                      <Sparkles className="size-4 text-purple-400" />
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>

            {isLoading && (
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex items-center gap-3"
              >
                <div className="flex size-8 items-center justify-center rounded-lg bg-blue-600/20">
                  <Bot className="size-4 text-blue-400" />
                </div>
                <div className="flex items-center gap-1 rounded-2xl bg-white/10 px-4 py-3 rounded-bl-md">
                  <span className="size-2 rounded-full bg-blue-400 animate-bounce [animation-delay:-0.3s]" />
                  <span className="size-2 rounded-full bg-blue-400 animate-bounce [animation-delay:-0.15s]" />
                  <span className="size-2 rounded-full bg-blue-400 animate-bounce" />
                </div>
              </motion.div>
            )}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 py-12">
            <div className="flex size-20 items-center justify-center rounded-2xl bg-blue-600/15 shadow-lg shadow-blue-500/10">
              <Bot className="size-10 text-blue-400" />
            </div>
            <div className="text-center">
              <p className="text-lg font-medium text-white">
                {t('aiAssistant.greeting')}
              </p>
              <p className="mt-1 text-sm text-slate-400">
                {t('aiAssistant.subtitle')}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Error Banner */}
      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="px-6"
          >
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-300">
              <AlertCircle className="size-4 shrink-0" />
              {error}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input Area */}
      <div className="border-t border-white/10 px-4 py-3 sm:px-6">
        <div className="flex items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={chatInputRef}
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={handleChatKeyDown}
              placeholder={t('aiAssistant.inputPlaceholder')}
              rows={1}
              className="w-full resize-none rounded-xl bg-white/5 border border-white/10 px-4 py-3 pr-12 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all"
              style={{ maxHeight: '120px' }}
              onInput={(e) => {
                const el = e.target as HTMLTextAreaElement;
                el.style.height = 'auto';
                el.style.height = Math.min(el.scrollHeight, 120) + 'px';
              }}
            />
            <Button
              size="icon"
              onClick={handleChatSubmit}
              disabled={!chatInput.trim() || isLoading}
              className="absolute right-2 bottom-2 size-8 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white"
            >
              <Send className="size-4" />
            </Button>
          </div>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-slate-500">
          {t('aiAssistant.shiftEnterHint')}
        </p>
      </div>
    </>
  );
}

/* ─── Rule View ───────────────────────────────────────────────────── */
function RuleView({
  isLoading,
  error,
  ruleInput,
  setRuleInput,
  handleRuleSubmit,
  handleRuleKeyDown,
  ruleInputRef,
  parsedRule,
  ruleReply,
  handleSaveRule,
  t,
}: {
  isLoading: boolean;
  error: string;
  ruleInput: string;
  setRuleInput: (v: string) => void;
  handleRuleSubmit: () => void;
  handleRuleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  ruleInputRef: React.RefObject<HTMLTextAreaElement | null>;
  parsedRule: ParsedRule | null;
  ruleReply: string;
  handleSaveRule: () => void;
  t: (key: string) => string;
}) {
  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-6">
        <div className="mx-auto max-w-lg space-y-6">
          {/* Instructions */}
          <div className="flex items-start gap-3">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-600/15">
              <Sparkles className="size-5 text-blue-400" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-white">
                {t('aiAssistant.ruleTitle')}
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-slate-400">
                {t('aiAssistant.ruleInstructions')}
              </p>
              <div className="mt-3 rounded-lg bg-white/5 border border-white/10 px-3 py-2">
                <p className="text-sm text-blue-300 font-mono">
                  {t('aiAssistant.ruleExample')}
                </p>
              </div>
            </div>
          </div>

          {/* Rule Reply */}
          {ruleReply && !parsedRule && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-lg bg-white/5 border border-white/10 px-4 py-3 text-sm text-slate-300"
            >
              {ruleReply}
            </motion.div>
          )}

          {/* Parsed Rule Card */}
          {parsedRule && (
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: 'spring', stiffness: 250, damping: 25 }}
              className="rounded-xl bg-white/5 border border-emerald-500/30 overflow-hidden"
            >
              <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                <h4 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
                  <Sparkles className="size-4" />
                  {t('aiAssistant.parsedRule')}
                </h4>
                <Badge className="bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border-emerald-500/30">
                  IA
                </Badge>
              </div>
              <div className="grid grid-cols-2 gap-3 p-4">
                <RuleField label={t('aiAssistant.ruleName')} value={parsedRule.name} />
                <RuleField
                  label={t('aiAssistant.condition')}
                  value={`${parsedRule.conditionType}: "${parsedRule.conditionValue}"`}
                />
                <RuleField
                  label={t('aiAssistant.account')}
                  value={parsedRule.glAccountName || '—'}
                />
                <RuleField
                  label={t('aiAssistant.direction')}
                  value={parsedRule.transactionDirection}
                />
                <RuleField
                  label={t('aiAssistant.priority')}
                  value={String(parsedRule.priority)}
                />
              </div>
              <div className="border-t border-white/10 px-4 py-3">
                <Button
                  onClick={handleSaveRule}
                  disabled={isLoading}
                  className="w-full bg-emerald-600 hover:bg-emerald-500 text-white"
                >
                  {isLoading ? (
                    <Loader2 className="size-4 animate-spin mr-2" />
                  ) : (
                    <Save className="size-4 mr-2" />
                  )}
                  {t('aiAssistant.saveRuleButton')}
                </Button>
              </div>
            </motion.div>
          )}

          {/* Error */}
          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
              >
                <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-300">
                  <AlertCircle className="size-4 shrink-0" />
                  {error}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Input Area */}
      <div className="border-t border-white/10 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-lg items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={ruleInputRef}
              value={ruleInput}
              onChange={(e) => setRuleInput(e.target.value)}
              onKeyDown={handleRuleKeyDown}
              placeholder={t('aiAssistant.inputPlaceholder')}
              rows={2}
              className="w-full resize-none rounded-xl bg-white/5 border border-white/10 px-4 py-3 pr-12 text-sm text-white placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-blue-500/50 focus:border-blue-500/50 transition-all"
              style={{ maxHeight: '120px' }}
            />
            <Button
              size="icon"
              onClick={handleRuleSubmit}
              disabled={!ruleInput.trim() || isLoading}
              className="absolute right-2 bottom-2 size-8 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white"
            >
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
            </Button>
          </div>
        </div>
        <p className="mt-1.5 text-center text-[11px] text-slate-500">
          {t('aiAssistant.shiftEnterHint')}
        </p>
      </div>
    </>
  );
}

/* ─── Rule Field Sub-component ────────────────────────────────────── */
function RuleField({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
        {label}
      </p>
      <p className="text-sm text-white font-medium truncate">{value}</p>
    </div>
  );
}
