'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Search, Loader2, ArrowRight, CalendarDays, FileText, CheckCircle2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFuzzyMatchAudit } from '@/hooks/useFuzzyMatchAudit';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { useLanguageStore } from '@/store/language-store';

interface LinkJournalModalProps {
  isOpen: boolean;
  onClose: () => void;
  bankTransaction: {
    id: string;
    description: string;
    amount: number;
    date: string;
    companyId: string;
  } | null;
  onLinked?: () => void;
}

interface JournalLine {
  id: string;
  debit: number;
  credit: number;
  description: string | null;
  glAccount: {
    code: string;
    name: string;
  };
}

interface JournalEntry {
  id: string;
  date: string;
  description: string;
  reference: string | null;
  lines: JournalLine[];
}

export function LinkJournalModal({
  isOpen,
  onClose,
  bankTransaction,
  onLinked,
}: LinkJournalModalProps) {
  const t = useLanguageStore((s) => s.t);
  const { linkTransaction, isLinking } = useFuzzyMatchAudit();

  const [searchQuery, setSearchQuery] = useState('');
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [selectedEntryId, setSelectedEntryId] = useState<string | null>(null);

  const searchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchEntries = useCallback(async (query: string) => {
    if (!bankTransaction) return;
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        companyId: bankTransaction.companyId,
        status: 'posted',
        limit: '15',
      });
      if (query) params.set('search', query);

      const res = await fetch(`/api/journal?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        setEntries(json.data || []);
      }
    } catch (error) {
      logger.error('Error fetching journal entries:', { error: String(error) });
      toast.error(t('audit.loadJournalFailed'));
    } finally {
      setIsLoading(false);
    }
  }, [bankTransaction, t]);

  useEffect(() => {
    if (isOpen && bankTransaction) {
      setSelectedEntryId(null);
      // Búsqueda inicial automática basada en parte de la descripción del banco
      const initialSearch = bankTransaction.description
        .replace(/Zelle payment (to|from)|Conf#.*|ID:.*|DES:.*/gi, '')
        .trim();
      setSearchQuery(initialSearch);
      fetchEntries(initialSearch);
    }
  }, [isOpen, bankTransaction, fetchEntries]);

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      fetchEntries(val);
    }, 450);
  };

  const handleLink = async (journalLineId: string) => {
    if (!bankTransaction) return;
    try {
      await linkTransaction({
        bankTransactionId: bankTransaction.id,
        journalLineId,
      });
      toast.success(t('audit.linkSuccess'));
      onLinked?.();
      onClose();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  if (!bankTransaction) return null;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[750px] max-h-[85vh] flex flex-col p-0 overflow-hidden">
        <div className="p-6 pb-4 border-b">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              Vincular Transacción Bancaria
            </DialogTitle>
            <DialogDescription>
              Selecciona el asiento y la línea contable correspondiente para registrar el flujo.
            </DialogDescription>
          </DialogHeader>

          {/* Transacción Bancaria Detalle */}
          <div className="mt-4 rounded-lg border bg-muted/30 p-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-sm">
            <div className="space-y-0.5">
              <p className="font-semibold text-foreground truncate max-w-[400px]">
                {bankTransaction.description}
              </p>
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <CalendarDays className="size-3.5" />
                {formatDate(bankTransaction.date)}
              </p>
            </div>
            <p
              className={`font-mono font-bold text-base ${bankTransaction.amount >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}
            >
              {formatCurrency(bankTransaction.amount)}
            </p>
          </div>

          {/* Buscador de Asientos */}
          <div className="relative mt-4">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
            <Input
              placeholder="Buscar asiento contable por descripción o referencia..."
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              className="pl-9 h-10 bg-background"
            />
          </div>
        </div>

        {/* Listado de Asientos */}
        <ScrollArea className="flex-1 p-6 pt-2">
          {isLoading ? (
            <div className="flex h-48 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-primary" />
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <FileText className="size-10 text-muted-foreground/30 mb-2.5" />
              <p className="text-sm font-semibold text-muted-foreground">
                No se encontraron asientos publicados
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Intenta buscar con otros términos o cambia la consulta.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {entries.map((entry) => {
                const isSelected = selectedEntryId === entry.id;

                return (
                  <div
                    key={entry.id}
                    className={`rounded-lg border transition-all ${
                      isSelected
                        ? 'border-primary bg-primary/[0.01] shadow-sm'
                        : 'hover:bg-muted/40'
                    }`}
                  >
                    <div
                      onClick={() => setSelectedEntryId(isSelected ? null : entry.id)}
                      className="p-4 flex items-center justify-between gap-3 cursor-pointer select-none"
                    >
                      <div className="space-y-1">
                        <p className="font-semibold text-sm text-foreground">{entry.description}</p>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          <span>{formatDate(entry.date)}</span>
                          {entry.reference && <span>Ref: {entry.reference}</span>}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-muted-foreground uppercase bg-muted px-2 py-0.5 rounded">
                          {entry.lines.length} líneas
                        </span>
                        <ArrowRight
                          className={`size-4 text-muted-foreground transition-transform duration-200 ${isSelected ? 'rotate-90 text-primary' : ''}`}
                        />
                      </div>
                    </div>

                    {/* Desplegable de líneas contables */}
                    {isSelected && (
                      <div className="border-t bg-muted/10 p-3 space-y-2 animate-in fade-in-50 slide-in-from-top-1 duration-150">
                        <p className="text-xs font-bold text-muted-foreground uppercase px-1">
                          Selecciona la línea contable a vincular:
                        </p>
                        <div className="space-y-1.5">
                          {entry.lines.map((line) => {
                            const isDebit = line.debit > 0;
                            const val = isDebit ? line.debit : line.credit;

                            return (
                              <div
                                key={line.id}
                                className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5 rounded-md border bg-card p-3 hover:border-primary/40 transition-colors"
                              >
                                <div className="space-y-0.5">
                                  <p className="text-sm font-semibold flex items-center gap-1.5">
                                    <span className="font-mono text-xs text-teal-600 dark:text-teal-400 bg-teal-500/10 px-1.5 py-0.5 rounded">
                                      {line.glAccount.code}
                                    </span>
                                    {line.glAccount.name}
                                  </p>
                                  {line.description && (
                                    <p className="text-xs text-muted-foreground">
                                      {line.description}
                                    </p>
                                  )}
                                </div>
                                <div className="flex items-center gap-3 self-end sm:self-auto">
                                  <span
                                    className={`text-sm font-mono font-bold ${isDebit ? 'text-primary' : 'text-muted-foreground'}`}
                                  >
                                    {isDebit ? 'Débito' : 'Crédito'}: {formatCurrency(val)}
                                  </span>
                                  <Button
                                    size="sm"
                                    onClick={() => handleLink(line.id)}
                                    disabled={isLinking}
                                    className="h-8 gap-1.5 px-3"
                                  >
                                    {isLinking ? (
                                      <Loader2 className="size-3 animate-spin" />
                                    ) : (
                                      <CheckCircle2 className="size-3.5" />
                                    )}
                                    Vincular
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
