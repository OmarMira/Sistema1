import type { CompanyKnowledgeRecord } from '../entity/types';

// ───────────────────────────────────────────────
// MatchResult — three-tier duplicate detection
// ───────────────────────────────────────────────

export type MatchResult =
  | {
      type: 'exact';
      knowledgeId: string;
      canonicalName: string;
    }
  | {
      type: 'high_similarity';
      candidate: {
        knowledgeId: string;
        canonicalName: string;
        similarity: number;
      };
    }
  | {
      type: 'medium_similarity';
      candidates: Array<{
        knowledgeId: string;
        canonicalName: string;
        similarity: number;
      }>;
    }
  | { type: 'no_match' };

// ───────────────────────────────────────────────
// Character bigram Jaccard similarity
// No external dependencies — pure string comparison
// ───────────────────────────────────────────────

export function characterBigramJaccard(a: string, b: string): number {
  const bigramsA = new Set<string>();
  const bigramsB = new Set<string>();

  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();

  for (let i = 0; i < lowerA.length - 1; i++) {
    bigramsA.add(lowerA.slice(i, i + 2));
  }

  for (let i = 0; i < lowerB.length - 1; i++) {
    bigramsB.add(lowerB.slice(i, i + 2));
  }

  // If both strings have fewer than 2 chars, compare them directly
  if (bigramsA.size === 0 && bigramsB.size === 0) {
    return lowerA === lowerB ? 1 : 0;
  }

  if (bigramsA.size === 0 || bigramsB.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const bigram of bigramsA) {
    if (bigramsB.has(bigram)) {
      intersection++;
    }
  }

  const union = bigramsA.size + bigramsB.size - intersection;

  return union === 0 ? 0 : intersection / union;
}

// ───────────────────────────────────────────────
// CompanyKnowledgeMatcher
// ───────────────────────────────────────────────

export class CompanyKnowledgeMatcher {
  private readonly records: CompanyKnowledgeRecord[];

  constructor(records: CompanyKnowledgeRecord[]) {
    this.records = records;
  }

  /**
   * Match a candidate name against known records.
   *
   * 1. Exact canonicalName or alias match → 'exact'
   * 2. similarity >= 0.9 → 'high_similarity' (blocks creation)
   * 3. similarity >= 0.7 → 'medium_similarity' (warns, allows)
   * 4. below 0.7 → 'no_match'
   */
  match(name: string): MatchResult {
    const lowerName = name.toLowerCase();

    // Phase 1: Exact match on canonicalName or aliases
    for (const record of this.records) {
      if (record.canonicalName.toLowerCase() === lowerName) {
        return {
          type: 'exact',
          knowledgeId: record.id,
          canonicalName: record.canonicalName,
        };
      }

      for (const alias of record.aliases ?? []) {
        if (alias.toLowerCase() === lowerName) {
          return {
            type: 'exact',
            knowledgeId: record.id,
            canonicalName: record.canonicalName,
          };
        }
      }
    }

    // Phase 2: Similarity check
    const candidates: Array<{
      knowledgeId: string;
      canonicalName: string;
      similarity: number;
    }> = [];

    for (const record of this.records) {
      // Check against canonicalName
      const nameSim = characterBigramJaccard(name, record.canonicalName);

      // Check against aliases (take the highest)
      let bestSim = nameSim;
      for (const alias of record.aliases ?? []) {
        const aliasSim = characterBigramJaccard(name, alias);
        if (aliasSim > bestSim) {
          bestSim = aliasSim;
        }
      }

      if (bestSim >= 0.7) {
        candidates.push({
          knowledgeId: record.id,
          canonicalName: record.canonicalName,
          similarity: bestSim,
        });
      }
    }

    // Sort by similarity descending
    candidates.sort((a, b) => b.similarity - a.similarity);

    if (candidates.length === 0) {
      return { type: 'no_match' };
    }

    const best = candidates[0];

    if (best.similarity >= 0.9) {
      return {
        type: 'high_similarity',
        candidate: best,
      };
    }

    return {
      type: 'medium_similarity',
      candidates,
    };
  }
}
