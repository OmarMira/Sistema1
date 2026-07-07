'use client';

import { useState } from 'react';
import {
  Loader2,
  HelpCircle,
  ArrowRightLeft,
  AlertCircle,
  Link,
  ChevronRight,
  TrendingUp,
  CheckCircle2,
} from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { useFuzzyMatchAudit } from '@/hooks/useFuzzyMatchAudit';
import { LinkJournalModal } from './LinkJournalModal';
import { formatCurrency, formatDate } from '@/lib/format';
import { toast } from 'sonner';
import { logger } from '@/lib/logger';
import { useLanguageStore } from '@/store/language-store';

interface FuzzyCandidate {
  id: string;
  description: string;
  amount: number;
  date: string;
  companyId: string;
}

interface FuzzyReviewTableProps {
  candidates: FuzzyCandidate[];
  isLoading?: boolean;
  onRefresh?: () => void;
}

interface MatchResult {
  id: string;
  description: string;
  amount: number;
  date: string;
  score: number;
  glAccount?: { code: string; name: string };
  journalLineId?: string;
}

export function FuzzyReviewTable({
  candidates,
  isLoading = false,
  onRefresh,
}: FuzzyReviewTableProps) {
  const t = useLanguageStore((s) => s.t);
  const { getFuzzyMatches, linkTransaction, isLinking } = useFuzzyMatchAudit();

  const [activeFuzzyTxId, setActiveFuzzyTxId] = useState<string | null>(null);
  const [fuzzyMatches, setFuzzyMatches] = useState<Record<string, MatchResult[]>>({});
  const [isSearchingMatches, setIsSearchingMatches] = useState<Record<string, boolean>>({});

  // Modal state
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedTxForModal, setSelectedTxForModal] = useState<FuzzyCandidate | null>(null);

  const handleSearchMatches = async (tx: FuzzyCandidate) => {
    setIsSearchingMatches((prev) => ({ ...prev, [tx.id]: true }));
    try {
      const data = await getFuzzyMatches({
        companyId: tx.companyId,
        targetDescription: tx.description,
        date: tx.date,
        amount: Math.abs(tx.amount),
        minScore: 60,
      });
      setFuzzyMatches((prev) => ({ ...prev, [tx.id]: data.matches || [] }));
      setActiveFuzzyTxId(tx.id);
    } catch (error) {
      logger.error('Error fetching matches:', { error: String(error) });
      toast.error(t('audit.loadMatchesFailed'));
    } finally {
      setIsSearchingMatches((prev) => ({ ...prev, [tx.id]: false }));
    }
  };

  const handleQuickLink = async (bankTxId: string, journalLineId: string) => {
    try {
      await linkTransaction({
        bankTransactionId: bankTxId,
        journalLineId,
      });
      toast.success(t('audit.linkSuccess'));
      onRefresh?.();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };

  const handleOpenManualLink = (tx: FuzzyCandidate) => {
    setSelectedTxForModal(tx);
    setIsModalOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  if (candidates.length === 0) {
    return (
      <Card className="border-dashed border-muted-foreground/20 bg-muted/5">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950/30 text-emerald-600 mb-3">
            <CheckCircle2 className="size-6" />
          </div>
          <p className="text-sm font-semibold text-foreground">
            Auditoría al día — 0 candidatos pendientes
          </p>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-sm">
            Todas las transacciones conciliadas han sido vinculadas a sus respectivos asientos
            contables en este período.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[12%]">Fecha</TableHead>
              <TableHead className="w-[45%]">Descripción en Banco</TableHead>
              <TableHead className="w-[15%] text-right">Monto</TableHead>
              <TableHead className="w-[28%] text-right">Acciones de Auditoría</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {candidates.map((tx) => {
              const isExpanded = activeFuzzyTxId === tx.id;
              const matches = fuzzyMatches[tx.id] || [];
              const isSearching = isSearchingMatches[tx.id] || false;

              return (
                <>
                  <TableRow key={tx.id} className={isExpanded ? 'bg-muted/10' : ''}>
                    <TableCell className="font-medium text-muted-foreground">
                      {formatDate(tx.date)}
                    </TableCell>
                    <TableCell>
                      <p className="font-semibold text-sm text-foreground">{tx.description}</p>
                    </TableCell>
                    <TableCell className="text-right font-mono font-bold">
                      <span className={tx.amount >= 0 ? 'text-emerald-600' : 'text-rose-600'}>
                        {formatCurrency(tx.amount)}
                      </span>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={isSearching}
                          onClick={() => handleSearchMatches(tx)}
                          className="h-8 gap-1.5"
                        >
                          {isSearching ? (
                            <Loader2 className="size-3 animate-spin" />
                          ) : (
                            <ArrowRightLeft className="size-3.5" />
                          )}
                          Buscar Coincidencias
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenManualLink(tx)}
                          className="h-8 gap-1 px-2.5 text-muted-foreground hover:text-primary"
                        >
                          <Link className="size-3.5" />
                          Manual
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>

                  {/* Panel expansible de coincidencias sugeridas */}
                  {isExpanded && (
                    <TableRow className="bg-muted/5 hover:bg-muted/5">
                      <TableCell colSpan={4} className="p-4 border-t">
                        <div className="space-y-3 pl-2">
                          <div className="flex items-center gap-1.5 text-xs font-bold text-muted-foreground uppercase">
                            <TrendingUp className="size-4 text-primary" />
                            Coincidencias Contables Sugeridas (Fuzzy Matching):
                          </div>

                          {matches.length === 0 ? (
                            <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-500/[0.02] p-3 text-xs text-amber-600">
                              <AlertCircle className="size-4 shrink-0" />
                              No se encontraron asientos con similitud suficiente (≥60%). Por favor,
                              usa la vinculación manual.
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                              {matches.map((match) => {
                                const isHighConfidence = match.score >= 80;
                                const isMediumConfidence = match.score >= 70 && match.score < 80;

                                return (
                                  <div
                                    key={match.id}
                                    className={`flex flex-col justify-between rounded-lg border bg-card p-3.5 transition-all ${
                                      isHighConfidence
                                        ? 'border-emerald-500/20 bg-emerald-500/[0.01]'
                                        : isMediumConfidence
                                          ? 'border-amber-500/20 bg-amber-500/[0.01]'
                                          : 'border-border'
                                    }`}
                                  >
                                    <div className="space-y-1.5">
                                      <div className="flex items-center justify-between gap-2">
                                        <Badge
                                          variant="secondary"
                                          className={`text-[10px] font-bold tracking-wider ${
                                            isHighConfidence
                                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
                                              : isMediumConfidence
                                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400'
                                                : 'bg-muted text-muted-foreground'
                                          }`}
                                        >
                                          Confianza: {match.score}%
                                        </Badge>
                                        <span className="text-xs text-muted-foreground">
                                          {formatDate(match.date)}
                                        </span>
                                      </div>

                                      <p className="font-semibold text-xs text-foreground truncate">
                                        {match.description}
                                      </p>

                                      {match.glAccount && (
                                        <p className="text-[11px] font-medium text-muted-foreground font-mono flex items-center gap-1">
                                          <span className="text-teal-600 dark:text-teal-400 bg-teal-500/10 px-1 rounded">
                                            {match.glAccount.code}
                                          </span>
                                          {match.glAccount.name}
                                        </p>
                                      )}
                                    </div>

                                    <div className="flex items-center justify-between border-t pt-3 mt-3">
                                      <span className="text-xs font-mono font-bold text-foreground">
                                        Monto: {formatCurrency(match.amount)}
                                      </span>
                                      {match.journalLineId ? (
                                        <Button
                                          size="sm"
                                          disabled={isLinking}
                                          onClick={() =>
                                            handleQuickLink(tx.id, match.journalLineId!)
                                          }
                                          className="h-7 text-xs gap-1 px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                                        >
                                          {isLinking ? (
                                            <Loader2 className="size-3 animate-spin" />
                                          ) : (
                                            <ChevronRight className="size-3.5" />
                                          )}
                                          Auto-vincular
                                        </Button>
                                      ) : (
                                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                                          <HelpCircle className="size-3.5" />
                                          Falta ID de línea
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <LinkJournalModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setSelectedTxForModal(null);
        }}
        bankTransaction={selectedTxForModal}
        onLinked={onRefresh}
      />
    </div>
  );
}
