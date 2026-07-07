import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { ValidationError } from '@/lib/api-error';
import { fetchFuzzyCandidates } from '@/lib/accounting/fuzzy-pre-filter';
import { runFuzzyMatch } from '@/lib/accounting/fuzzy-matcher';
import { createDateWindow } from '@/lib/accounting/date-window';
import { logger } from '@/lib/logger';

/**
 * POST /api/accounting-flow/audit/fuzzy-match
 *
 * Detecta transacciones bancarias funcionalmente similares a una descripción
 * dada, usando pre-filtro SQLite + fuzzy match con fuse.js en runtime.
 *
 * Body:
 *   - companyId: string (requerido)
 *   - targetDescription: string (requerido)
 *   - date: string ISO (requerido) — fecha de referencia para la ventana ±7 días
 *   - amount: number (requerido)
 *   - minScore?: number — umbral mínimo de similitud 0-100 (default: 65)
 *   - windowDays?: number — ventana de días ±N (default: 7)
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const body = await request.json();
  const { targetDescription, date, amount, minScore = 65, windowDays = 7 } = body;

  if (!targetDescription || !date || amount === undefined) {
    throw new ValidationError(
      'Faltan campos requeridos: companyId, targetDescription, date, amount',
    );
  }

  const baseDate = new Date(date);
  if (isNaN(baseDate.getTime())) {
    throw new ValidationError('El campo date no es una fecha ISO válida');
  }

  // Ventana de búsqueda UTC-segura
  const { from, to } = createDateWindow(baseDate, windowDays);

  try {
    // 1. Pre-filtro en SQLite (Date objects — nunca number)
     
    const candidates = await fetchFuzzyCandidates(db as any, {
      companyId,
      dateFrom: from,
      dateTo: to,
      amount,
      description: targetDescription, // Para tolerancia dinámica (Zelle ±10%)
      tolerancePercent: 0.02,
      limit: 300,
    });

    if (candidates.length === 0) {
      return NextResponse.json({ matches: [], candidateCount: 0 });
    }

    // 2. Fuzzy match en memoria
    const matches = runFuzzyMatch(candidates, targetDescription, minScore);

    // 3. Log de auditoría para scores bajos (posibles duplicados que requieren revisión)
    const lowScoreMatches = matches.filter((m) => m.score < 80);
    if (lowScoreMatches.length > 0) {
      logger.warn?.(
        `[fuzzy-match] ${lowScoreMatches.length} matches con score <80% para companyId=${companyId}`,
      );
    }

    return NextResponse.json({
      matches,
      candidateCount: candidates.length,
      meta: {
        windowDays,
        minScore,
        dateFrom: from.toISOString(),
        dateTo: to.toISOString(),
      },
    });
  } catch (err) {
    // Fallback seguro: nunca romper la ruta por error de fuzzy
    logger.error?.(`[fuzzy-match] Error inesperado: ${err}`);
    return NextResponse.json({ matches: [], candidateCount: 0 });
  }
});
