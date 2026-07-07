import Fuse, { type IFuseOptions } from 'fuse.js';
import { normalizeBankDescription } from './normalize-description';
import type { FuzzyCandidate } from './fuzzy-pre-filter';

export interface FuzzyMatchResult {
  id: string;
  description: string;
  amount: number;
  date: Date;
  /** Similitud en porcentaje: 100 = idéntico, 0 = sin relación */
  score: number;
}

interface FuseCandidate extends FuzzyCandidate {
  normalizedDescription: string;
}

const FUSE_OPTIONS: IFuseOptions<FuseCandidate> = {
  keys: [{ name: 'normalizedDescription', weight: 1 }],
  threshold: 0.35, // ~65% similitud mínima (fuse usa distancia, no similitud)
  ignoreLocation: true, // Busca en toda la cadena, no solo al inicio
  includeScore: true,
  minMatchCharLength: 4, // Ignora tokens cortos como "ID:", "CCD"
};

/**
 * Ejecuta fuzzy matching en memoria sobre candidatos pre-filtrados de PostgreSQL.
 * Devuelve matches ordenados por score descendente (mayor = más similar).
 *
 * @param candidates - Resultado de fetchFuzzyCandidates()
 * @param targetDescription - Descripción de la transacción a comparar
 * @param minScore - Umbral mínimo de similitud (0-100). Default 65.
 */
export function runFuzzyMatch(
  candidates: FuzzyCandidate[],
  targetDescription: string,
  minScore = 65,
): FuzzyMatchResult[] {
  if (candidates.length === 0) return [];

  const prepared: FuseCandidate[] = candidates.map((c) => ({
    ...c,
    normalizedDescription: normalizeBankDescription(c.description),
  }));

  const fuse = new Fuse(prepared, FUSE_OPTIONS);
  const targetNorm = normalizeBankDescription(targetDescription);
  const results = fuse.search(targetNorm);

  return results
    .filter((r) => {
      const similarity = Math.round((1 - (r.score ?? 1)) * 100);
      return similarity >= minScore;
    })
    .map((r) => ({
      id: r.item.id,
      description: r.item.description,
      amount: r.item.amount,
      date: r.item.date,
      score: Math.round((1 - (r.score ?? 1)) * 100),
    }))
    .sort((a, b) => b.score - a.score);
}
