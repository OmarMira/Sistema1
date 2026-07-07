'use client';

import { useState } from 'react';
import { ShieldCheck, ChevronDown, ChevronUp } from 'lucide-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { FuzzyReviewTable } from './FuzzyReviewTable';

interface AuditSectionProps {
  transactions: {
    id: string;
    date: string;
    description: string;
    amount: number;
    source: 'journal' | 'bank_transaction';
  }[];
  companyId?: string | null;
  isLoading?: boolean;
  onRefresh?: () => void;
}

export function AuditSection({
  transactions,
  companyId,
  isLoading = false,
  onRefresh,
}: AuditSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (!companyId) return null;

  // Filtrar los candidatos de auditoría (transacciones bancarias no vinculadas)
  const auditCandidates = transactions
    .filter((t) => t.source === 'bank_transaction')
    .map((t) => ({
      id: t.id.replace('bt-', ''), // Remover prefijo del flujo consolidado
      description: t.description,
      amount: t.amount,
      date: t.date,
      companyId,
    }));

  const pendingCount = auditCandidates.length;

  return (
    <Card
      className={`border-purple-500/10 shadow-lg bg-gradient-to-br from-card to-purple-500/[0.005]`}
    >
      <CardHeader
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex flex-row items-center justify-between space-y-0 pb-4 cursor-pointer select-none"
      >
        <CardTitle className="text-base font-bold flex items-center gap-2">
          <ShieldCheck className="size-5 text-purple-600 dark:text-purple-400 animate-pulse" />
          Módulo de Auditoría de Flujo
          {pendingCount > 0 && (
            <span className="ml-1.5 rounded-full bg-purple-100 dark:bg-purple-950/70 px-2 py-0.5 text-xs font-bold text-purple-600 dark:text-purple-400">
              {pendingCount} pendientes
            </span>
          )}
        </CardTitle>
        <button className="text-muted-foreground hover:text-foreground transition-colors">
          {isExpanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </CardHeader>

      {isExpanded && (
        <CardContent className="space-y-4 pt-0 animate-in fade-in-50 slide-in-from-top-1 duration-200">
          <div className="text-xs text-muted-foreground pb-2 border-b">
            Detecta movimientos bancarios que requieren vinculación manual o inteligente con
            asientos contables. Vincular transacciones elimina el riesgo de doble cómputo en tus
            reportes.
          </div>
          <FuzzyReviewTable
            candidates={auditCandidates}
            isLoading={isLoading}
            onRefresh={onRefresh}
          />
        </CardContent>
      )}
    </Card>
  );
}
