'use client';

import { useEffect, useRef, useCallback, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bot, Sparkles, Loader2, Send, AlertCircle, Plus, Save, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLanguageStore } from '@/store/language-store';
import { useAuthStore } from '@/store/auth-store';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/lib/types/ai-assistant';
import { messageVariants } from '@/lib/types/ai-assistant';

interface ChatViewProps {
  messages: ChatMessage[];
  isLoading: boolean;
  error: string;
  chatInput: string;
  setChatInput: (val: string) => void;
  handleChatSubmit: () => void;
  handleChatKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  chatScrollRef: React.RefObject<HTMLDivElement | null>;
  chatInputRef: React.RefObject<HTMLTextAreaElement | null>;
  handleStartWizard: () => Promise<void>;
  wizardOpen: boolean;
  setWizardOpen: (open: boolean) => void;
  wizardCode: string;
  setWizardCode: (code: string) => void;
  wizardName: string;
  setWizardName: (name: string) => void;
  handleSaveWizardAccount: () => Promise<void>;
}

export function ChatView({
  messages,
  isLoading,
  error,
  chatInput,
  setChatInput,
  handleChatSubmit,
  handleChatKeyDown,
  chatScrollRef,
  chatInputRef,
  handleStartWizard,
  wizardOpen,
  setWizardOpen,
  wizardCode,
  setWizardCode,
  wizardName,
  setWizardName,
  handleSaveWizardAccount,
}: ChatViewProps) {
  const t = useLanguageStore.getState().t;
  const setCurrentView = useAuthStore((s) => s.setCurrentView);
  const setAiAssistantOpen = useAuthStore((s) => s.setAiAssistantOpen);

  const hasMessages = messages.length > 0;

  function parseMessageContent(text: string) {
    let parsed = text.replace('[Te ayudo a crearla](action:create-account)', '').trim();
    const parts: ReactNode[] = [];
    const regex = /\[([^\]]+)\]\(([^)]+)\)/g;
    let lastIndex = 0;
    let match;
    while ((match = regex.exec(parsed)) !== null) {
      if (match.index > lastIndex) {
        parts.push(parsed.substring(lastIndex, match.index));
      }
      const label = match[1];
      const url = match[2];

      if (url.startsWith('/')) {
        let viewPath = url.split('?')[0].replace('/', '');
        if (viewPath === 'bank-transactions') viewPath = 'reconciliation';
        if (viewPath === 'transactions') viewPath = 'reconciliation';

        parts.push(
          <a
            key={match.index}
            onClick={(e) => {
              e.preventDefault();
              window.history.pushState({}, '', url);
              setCurrentView(viewPath as any);
              setAiAssistantOpen(false);
            }}
            className="underline text-blue-300 hover:text-blue-100 font-medium transition-colors cursor-pointer"
          >
            {label}
          </a>,
        );
      } else {
        parts.push(
          <a
            href={url}
            key={match.index}
            className="underline text-blue-300 hover:text-blue-100 font-medium transition-colors cursor-pointer"
            target="_blank"
            rel="noopener noreferrer"
          >
            {label}
          </a>,
        );
      }
      lastIndex = regex.lastIndex;
    }
    if (lastIndex < parsed.length) {
      parts.push(parsed.substring(lastIndex));
    }
    return parts.length > 0 ? parts : parsed;
  }

  return (
    <>
      {/* Chat Messages or Welcome */}
      <div ref={chatScrollRef} className="flex-1 overflow-y-auto px-6 py-4">
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
                    msg.role === 'user' ? 'justify-end' : 'justify-start',
                  )}
                >
                  {msg.role === 'assistant' && (
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue-600/20 mt-0.5">
                      <Bot className="size-4 text-blue-400" />
                    </div>
                  )}
                  <div className="flex flex-col gap-2 max-w-[80%]">
                    <div
                      className={cn(
                        'rounded-2xl px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap',
                        msg.role === 'user'
                          ? 'bg-blue-600 text-white rounded-br-md'
                          : 'bg-white/10 text-slate-200 rounded-bl-md',
                      )}
                    >
                      {parseMessageContent(msg.content)}
                    </div>
                    {msg.role === 'assistant' && msg.content.includes('action:create-account') && (
                      <Button
                        size="sm"
                        onClick={handleStartWizard}
                        className="self-start mt-1 bg-blue-600 hover:bg-blue-500 text-white gap-1 text-xs px-3 py-1.5 rounded-lg shadow-md font-semibold border border-blue-500/30"
                      >
                        <Sparkles className="size-3.5" />
                        Te ayudo a crearla
                      </Button>
                    )}
                  </div>
                  {msg.role === 'user' && (
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-purple-600/20 mt-0.5">
                      <Sparkles className="size-4 text-purple-400" />
                    </div>
                  )}
                </motion.div>
              ))}
            </AnimatePresence>

            {/* Inline Bank Account Creation Wizard */}
            {wizardOpen && (
              <motion.div
                initial={{ opacity: 0, y: 12, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                className="p-4 rounded-xl bg-slate-800/90 border border-blue-500/40 shadow-xl space-y-4 max-w-sm ml-11 backdrop-blur-sm"
              >
                <div className="flex items-center gap-2 text-blue-400 font-semibold text-xs">
                  <Sparkles className="size-4 animate-pulse text-blue-300" />
                  <span>Asistente de Cuenta Contable</span>
                </div>

                <div className="space-y-3 text-xs">
                  <div className="space-y-1">
                    <label className="text-slate-400 font-medium">Código de Cuenta:</label>
                    <Input
                      value={wizardCode}
                      onChange={(e) => setWizardCode(e.target.value)}
                      placeholder="Ej. 1011"
                      className="bg-slate-900 border-white/10 text-white text-xs h-8 focus:ring-blue-500/50"
                    />
                  </div>

                  <div className="space-y-1">
                    <label className="text-slate-400 font-medium">Nombre de Cuenta:</label>
                    <Input
                      value={wizardName}
                      onChange={(e) => setWizardName(e.target.value)}
                      placeholder="Ej. Banco Chase - Corriente 1234"
                      className="bg-slate-900 border-white/10 text-white text-xs h-8 focus:ring-blue-500/50"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-[10px] text-slate-400 bg-white/5 p-2 rounded-lg border border-white/5">
                    <div>
                      <span className="font-semibold block text-slate-500">TIPO:</span> Activo
                      (Asset)
                    </div>
                    <div>
                      <span className="font-semibold block text-slate-500">SALDO NORMAL:</span>{' '}
                      Débito
                    </div>
                    <div className="col-span-2">
                      <span className="font-semibold block text-slate-500">CUENTA PADRE:</span> 1010
                      - Cash & Cash Equivalents
                    </div>
                  </div>
                </div>

                <div className="flex gap-2 pt-1">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setWizardOpen(false)}
                    className="flex-1 text-xs border-white/10 hover:bg-white/5 text-slate-300 h-8"
                  >
                    Cancelar
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSaveWizardAccount}
                    disabled={!wizardCode.trim() || !wizardName.trim()}
                    className="flex-1 bg-blue-600 hover:bg-blue-500 text-white text-xs h-8"
                  >
                    Crear Cuenta
                  </Button>
                </div>
              </motion.div>
            )}

            {isLoading && !wizardOpen && (
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
              <p className="text-lg font-medium text-white">{t('aiAssistant.greeting')}</p>
              <p className="mt-1 text-sm text-slate-400">{t('aiAssistant.subtitle')}</p>
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
