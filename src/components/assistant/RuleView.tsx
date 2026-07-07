'use client';

import { useRef, useEffect, useCallback, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, Sparkles, Loader2, Send, AlertCircle, FilePlus2, Save, CheckCircle, X, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { cn } from '@/lib/utils';
import type { ChatMessage, ParsedRule, HistoryEntry, ConditionV2 } from '@/lib/types/ai-assistant';
import { messageVariants } from '@/lib/types/ai-assistant';

interface RuleViewProps {
  isLoading: boolean;
  error: string;
  ruleInput: string;
  setRuleInput: (val: string) => void;
  handleRuleSubmit: () => void;
  handleRuleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  ruleInputRef: React.RefObject<HTMLTextAreaElement | null>;
  parsedRule: ParsedRule | null;
  setParsedRule: React.Dispatch<React.SetStateAction<ParsedRule | null>>;
  accounts: { id: string; name: string; code: string }[];
  ruleMessages: ChatMessage[];
  ruleIsComplete: boolean;
  handleSaveRule: () => void;
}

export function RuleView({
  isLoading,
  error,
  ruleInput,
  setRuleInput,
  handleRuleSubmit,
  handleRuleKeyDown,
  ruleInputRef,
  parsedRule,
  setParsedRule,
  accounts,
  ruleMessages,
  ruleIsComplete,
  handleSaveRule,
}: RuleViewProps) {
  const t = useLanguageStore.getState().t;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [ruleMessages, parsedRule, isLoading]);

  const hasMessages = ruleMessages.length > 0;

  return (
    <>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-6">
        {hasMessages ? (
          <div className="space-y-4">
            <AnimatePresence>
              {ruleMessages.map((msg) => (
                <motion.div
                  key={msg.id}
                  variants={messageVariants}
                  initial="hidden"
                  animate="visible"
                  className={cn(
                    'flex gap-3',
                    msg.role === 'user' ? 'justify-end' : 'justify-start',
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
                        : 'bg-white/10 text-slate-200 rounded-bl-md',
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

            {/* Loading indicator */}
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

            {/* Parsed Rule Card — only when complete */}
            {ruleIsComplete && parsedRule && !isLoading && (
              <motion.div
                initial={{ opacity: 0, y: 12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ type: 'spring', stiffness: 250, damping: 25 }}
                className="rounded-xl bg-white/5 border border-emerald-500/30 overflow-hidden ml-11"
              >
                <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                  <h4 className="text-sm font-semibold text-emerald-400 flex items-center gap-2">
                    <Sparkles className="size-4" />
                    {t('aiAssistant.parsedRule')}
                  </h4>
                  <div className="flex items-center gap-2">
                    {parsedRule.confidence !== undefined && (
                      <Badge
                        variant={
                          parsedRule.confidence >= 0.8 ? 'default' :
                          parsedRule.confidence >= 0.5 ? 'secondary' :
                          'destructive'
                        }
                        className="text-[10px]"
                      >
                        {parsedRule.confidence >= 0.8
                          ? t('ruleBuilder.highConfidence')
                          : parsedRule.confidence >= 0.5
                            ? t('ruleBuilder.mediumConfidence')
                            : t('ruleBuilder.lowConfidence')}
                      </Badge>
                    )}
                    <Badge className="bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 border-emerald-500/30">
                      Listo
                    </Badge>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3 p-4">
                  {/* Name */}
                  <div className="space-y-1">
                    <Label
                      htmlFor="parsed-rule-name"
                      className="text-[11px] font-medium uppercase tracking-wider text-slate-400"
                    >
                      Nombre
                    </Label>
                    <Input
                      id="parsed-rule-name"
                      value={parsedRule.name}
                      onChange={(e) => setParsedRule({ ...parsedRule, name: e.target.value })}
                      className="bg-slate-900/40 border-white/10 text-white text-xs h-8 focus:ring-emerald-500/50"
                    />
                  </div>

                  {/* Direction */}
                  <div className="space-y-1">
                    <Label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                      Dirección
                    </Label>
                    <Select
                      value={parsedRule.transactionDirection}
                      onValueChange={(val) =>
                        setParsedRule({ ...parsedRule, transactionDirection: val })
                      }
                    >
                      <SelectTrigger className="bg-slate-900/40 border-white/10 text-white text-xs h-8">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-slate-900 border-white/10 text-white text-xs">
                        <SelectItem value="any">Cualquiera</SelectItem>
                        <SelectItem value="debit">Débito</SelectItem>
                        <SelectItem value="credit">Crédito</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Conditions */}
                  {parsedRule.conditions?.map((c, i) => (
                    <div
                      key={i}
                      className="col-span-2 grid grid-cols-2 gap-3 border-t border-white/5 pt-3 mt-1"
                    >
                      <div className="space-y-1">
                        <Label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                          Condición {parsedRule.conditions.length > 1 ? i + 1 : ''} (Tipo)
                        </Label>
                        <Select
                          value={c.operator}
                          onValueChange={(val: string) => {
                            const updated = [...parsedRule.conditions];
                            updated[i] = { ...updated[i], operator: val as ConditionV2['operator'] };
                            setParsedRule({ ...parsedRule, conditions: updated });
                          }}
                        >
                          <SelectTrigger className="bg-slate-900/40 border-white/10 text-white text-xs h-8">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="bg-slate-900 border-white/10 text-white text-xs">
                            <SelectItem value="contains">Contiene</SelectItem>
                            <SelectItem value="starts_with">Empieza con</SelectItem>
                            <SelectItem value="ends_with">Termina con</SelectItem>
                            <SelectItem value="equals">Igual a</SelectItem>
                            <SelectItem value="amount_greater">Monto mayor que</SelectItem>
                            <SelectItem value="amount_less">Monto menor que</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                          Condición {parsedRule.conditions.length > 1 ? i + 1 : ''} (Valor)
                        </Label>
                        <Input
                          value={c.value}
                          onChange={(e) => {
                            const updated = [...parsedRule.conditions];
                            updated[i] = { ...updated[i], value: e.target.value };
                            setParsedRule({ ...parsedRule, conditions: updated });
                          }}
                          className="bg-slate-900/40 border-white/10 text-white text-xs h-8 focus:ring-emerald-500/50"
                        />
                      </div>
                    </div>
                  ))}

                  {/* GL Account selectors */}
                  {(() => {
                    const showGlAccount =
                      parsedRule.glAccountName !== undefined && parsedRule.glAccountName !== null;
                    const showDebitGlAccount =
                      parsedRule.debitGlAccountName !== undefined &&
                      parsedRule.debitGlAccountName !== null;
                    const showCreditGlAccount =
                      parsedRule.creditGlAccountName !== undefined &&
                      parsedRule.creditGlAccountName !== null;
                    const hasAnyAccountField =
                      showGlAccount || showDebitGlAccount || showCreditGlAccount;
                    const renderGlAccount = showGlAccount || !hasAnyAccountField;

                    return (
                      <>
                        {renderGlAccount && (
                          <div className="space-y-1">
                            <Label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                              Cuenta
                            </Label>
                            <Select
                              value={parsedRule.glAccountName || ''}
                              onValueChange={(val) =>
                                setParsedRule({ ...parsedRule, glAccountName: val })
                              }
                            >
                              <SelectTrigger className="bg-slate-900/40 border-white/10 text-white text-xs h-8">
                                <SelectValue placeholder="Seleccionar cuenta..." />
                              </SelectTrigger>
                              <SelectContent className="bg-slate-900 border-white/10 text-white text-xs max-h-60 overflow-y-auto">
                                {accounts.map((acc) => (
                                  <SelectItem key={acc.id} value={acc.name}>
                                    <span className="font-mono text-slate-500 mr-2">
                                      {acc.code}
                                    </span>
                                    {acc.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}

                        {showDebitGlAccount && (
                          <div className="space-y-1">
                            <Label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                              Cuenta (salidas)
                            </Label>
                            <Select
                              value={parsedRule.debitGlAccountName || ''}
                              onValueChange={(val) =>
                                setParsedRule({ ...parsedRule, debitGlAccountName: val })
                              }
                            >
                              <SelectTrigger className="bg-slate-900/40 border-white/10 text-white text-xs h-8">
                                <SelectValue placeholder="Seleccionar cuenta de débito..." />
                              </SelectTrigger>
                              <SelectContent className="bg-slate-900 border-white/10 text-white text-xs max-h-60 overflow-y-auto">
                                {accounts.map((acc) => (
                                  <SelectItem key={acc.id} value={acc.name}>
                                    <span className="font-mono text-slate-500 mr-2">
                                      {acc.code}
                                    </span>
                                    {acc.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}

                        {showCreditGlAccount && (
                          <div className="space-y-1">
                            <Label className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
                              Cuenta (entradas)
                            </Label>
                            <Select
                              value={parsedRule.creditGlAccountName || ''}
                              onValueChange={(val) =>
                                setParsedRule({ ...parsedRule, creditGlAccountName: val })
                              }
                            >
                              <SelectTrigger className="bg-slate-900/40 border-white/10 text-white text-xs h-8">
                                <SelectValue placeholder="Seleccionar cuenta de crédito..." />
                              </SelectTrigger>
                              <SelectContent className="bg-slate-900 border-white/10 text-white text-xs max-h-60 overflow-y-auto">
                                {accounts.map((acc) => (
                                  <SelectItem key={acc.id} value={acc.name}>
                                    <span className="font-mono text-slate-500 mr-2">
                                      {acc.code}
                                    </span>
                                    {acc.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* Priority */}
                  <div className="space-y-1">
                    <Label
                      htmlFor="parsed-rule-priority"
                      className="text-[11px] font-medium uppercase tracking-wider text-slate-400"
                    >
                      Prioridad
                    </Label>
                    <Input
                      id="parsed-rule-priority"
                      type="number"
                      min={0}
                      max={20}
                      value={parsedRule.priority}
                      onChange={(e) => {
                        const val = parseInt(e.target.value, 10);
                        if (!isNaN(val)) {
                          setParsedRule({ ...parsedRule, priority: val });
                        }
                      }}
                      className="bg-slate-900/40 border-white/10 text-white text-xs h-8 focus:ring-emerald-500/50"
                    />
                  </div>
                </div>

                {parsedRule.explanation && (
                  <div className="border-t border-white/10 px-4 py-3">
                    <div className={`rounded-lg p-3 border ${
                      (parsedRule.confidence ?? 0.85) >= 0.8
                        ? 'bg-green-500/5 border-green-500/20'
                        : (parsedRule.confidence ?? 0.85) >= 0.5
                          ? 'bg-amber-500/5 border-amber-500/20'
                          : 'bg-red-500/5 border-red-500/20'
                    }`}>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        {parsedRule.explanation}
                      </p>
                      {parsedRule.uncertaintyReasons && parsedRule.uncertaintyReasons.length > 0 && (
                        <ul className="mt-2 space-y-1">
                          {parsedRule.uncertaintyReasons.map((reason, idx) => (
                            <li key={idx} className="text-xs text-slate-400 flex items-start gap-1">
                              <span className="text-red-400 mt-0.5">•</span>
                              {reason}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                )}

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
          </div>
        ) : (
          /* Welcome screen when no messages yet */
          <div className="mx-auto max-w-lg space-y-6">
            <div className="flex items-start gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-blue-600/15">
                <Sparkles className="size-5 text-blue-400" />
              </div>
              <div>
                <h3 className="text-base font-semibold text-white">{t('aiAssistant.ruleTitle')}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-400">
                  {t('aiAssistant.ruleInstructions')}
                </p>
                <div className="mt-3 rounded-lg bg-white/5 border border-white/10 px-3 py-2">
                  <p className="text-sm text-blue-300 font-mono">{t('aiAssistant.ruleExample')}</p>
                </div>
              </div>
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
              <span className="flex-1">{error}</span>
              {(error.includes('no configurada') || error.includes('not configured')) && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs border-red-500/30 hover:bg-red-500/20 shrink-0"
                  onClick={() => {
                    useAuthStore.getState().setAiAssistantOpen(false);
                    useAuthStore.getState().setSettingsActiveTab('ai-config');
                    useAuthStore.getState().setCurrentView('settings');
                  }}
                >
                  <Settings className="h-3 w-3 mr-1" />
                  {t('settings.aiConfigTab')}
                </Button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input Area */}
      <div className="border-t border-white/10 px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-lg items-end gap-2">
          <div className="flex-1 relative">
            <textarea
              ref={ruleInputRef}
              value={ruleInput}
              onChange={(e) => setRuleInput(e.target.value)}
              onKeyDown={handleRuleKeyDown}
              placeholder={
                hasMessages ? 'Responde la pregunta de la IA...' : t('aiAssistant.inputPlaceholder')
              }
              rows={hasMessages ? 1 : 2}
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
      <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className="text-sm text-white font-medium truncate">{value}</p>
    </div>
  );
}
