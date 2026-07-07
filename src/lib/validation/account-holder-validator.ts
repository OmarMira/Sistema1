import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const DEFAULT_BUSINESS_SUFFIXES = [
  'llc',
  'l.l.c.',
  'inc',
  'inc.',
  'incorporated',
  'corp',
  'corp.',
  'corporation',
  'ltd',
  'ltd.',
  'limited',
  'sa',
  's.a',
  's.a.',
  's.a.s',
  'sac',
  'sl',
  's.l',
  's.l.',
  'srl',
  's.r.l',
  's.r.l.',
  'gmbh',
  'ag',
  'plc',
  'llp',
  'lp',
  'pty',
  'ptyltd',
  'co',
  'company',
  'group',
  'holdings',
  'llc.',
  'ltda',
  'eirl',
];

const DEFAULT_THRESHOLDS = {
  business: { levenshtein: 0.85, token: 0.6 },
  individual: { levenshtein: 0.75, token: 0.5 },
};

interface HolderValidationConfig {
  enabled: boolean;
  businessSuffixes: string[];
  thresholds: {
    business: { levenshtein: number; token: number };
    individual: { levenshtein: number; token: number };
  };
}

function loadConfig(): HolderValidationConfig {
  try {
    const configPath = join(process.cwd(), 'rules/import-config.json');
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, 'utf-8'));
      const v = config.accountHolderValidation;
      if (!v) return buildDefaultConfig();
      return {
        enabled: v.enabled ?? true,
        businessSuffixes: v.businessSuffixes ?? DEFAULT_BUSINESS_SUFFIXES,
        thresholds: {
          business: {
            levenshtein:
              v.thresholds?.business?.levenshtein ?? DEFAULT_THRESHOLDS.business.levenshtein,
            token: v.thresholds?.business?.token ?? DEFAULT_THRESHOLDS.business.token,
          },
          individual: {
            levenshtein:
              v.thresholds?.individual?.levenshtein ?? DEFAULT_THRESHOLDS.individual.levenshtein,
            token: v.thresholds?.individual?.token ?? DEFAULT_THRESHOLDS.individual.token,
          },
        },
      };
    }
  } catch {
    // ignore
  }
  return buildDefaultConfig();
}

function buildDefaultConfig(): HolderValidationConfig {
  return {
    enabled: true,
    businessSuffixes: DEFAULT_BUSINESS_SUFFIXES,
    thresholds: DEFAULT_THRESHOLDS,
  };
}

function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshteinSimilarity(a: string, b: string): number {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0) return lenB === 0 ? 1 : 0;
  const dp = Array.from({ length: lenA + 1 }, (_, i) =>
    Array.from({ length: lenB + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= lenA; i++) {
    for (let j = 1; j <= lenB; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return 1 - dp[lenA][lenB] / Math.max(lenA, lenB);
}

function stripSuffixes(name: string, suffixes: string[]): string {
  const tokens = name.split(/\s+/);
  while (tokens.length > 1 && suffixes.includes(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ');
}

function tokenSimilarity(a: string, b: string): number {
  const tokensA = new Set(a.split(/\s+/).filter(Boolean));
  const tokensB = new Set(b.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  const intersection = new Set([...tokensA].filter((t) => tokensB.has(t)));
  const union = new Set([...tokensA, ...tokensB]);
  return intersection.size / union.size;
}

function individualTokenMatch(pdfTokens: string[], companyTokens: string[]): number {
  const sameFirstName =
    pdfTokens.length > 0 && companyTokens.length > 0 && pdfTokens[0] === companyTokens[0];
  const sameLastName =
    pdfTokens.length > 1 &&
    companyTokens.length > 1 &&
    pdfTokens[pdfTokens.length - 1] === companyTokens[companyTokens.length - 1];

  if (sameFirstName && sameLastName) return 1.0;
  if (sameFirstName || sameLastName) return 0.7;
  return tokenSimilarity(pdfTokens.join(' '), companyTokens.join(' '));
}

function bestBusinessScore(
  normPdf: string,
  normCompany: string,
  suffixes: string[],
  thresholds: { levenshtein: number; token: number },
): { score: number; method: string; meetsThreshold: boolean } {
  const rawLev = levenshteinSimilarity(normPdf, normCompany);
  const rawTok = tokenSimilarity(normPdf, normCompany);

  const strippedPdf = stripSuffixes(normPdf, suffixes);
  const strippedCompany = stripSuffixes(normCompany, suffixes);

  const strippedLev = levenshteinSimilarity(strippedPdf, strippedCompany);
  const strippedTok = tokenSimilarity(strippedPdf, strippedCompany);

  const candidates = [
    { score: rawLev, method: 'levenshtein' },
    { score: rawTok, method: 'token' },
    { score: strippedLev, method: 'levenshtein_stripped' },
    { score: strippedTok, method: 'token_stripped' },
  ];

  const best = candidates.reduce((a, b) => (a.score >= b.score ? a : b));

  return {
    score: best.score,
    method: `${best.method}=${best.score.toFixed(3)} (raw lev=${rawLev.toFixed(3)})`,
    meetsThreshold: best.score >= thresholds.levenshtein || best.score >= thresholds.token,
  };
}

function bestIndividualScore(
  normPdf: string,
  normCompany: string,
  thresholds: { levenshtein: number; token: number },
): { score: number; method: string; meetsThreshold: boolean } {
  const pdfTokens = normPdf.split(/\s+/);
  const companyTokens = normCompany.split(/\s+/);

  const rawLev = levenshteinSimilarity(normPdf, normCompany);
  const tokMatch = individualTokenMatch(pdfTokens, companyTokens);
  const rawTok = tokenSimilarity(normPdf, normCompany);

  const candidates = [
    { score: rawLev, method: 'levenshtein' },
    { score: tokMatch, method: 'individual_token' },
    { score: rawTok, method: 'token' },
  ];

  const best = candidates.reduce((a, b) => (a.score >= b.score ? a : b));

  return {
    score: best.score,
    method: `${best.method}=${best.score.toFixed(3)} (raw lev=${rawLev.toFixed(3)})`,
    meetsThreshold: best.score >= thresholds.levenshtein || best.score >= thresholds.token,
  };
}

export function isStrictModeEnabled(): boolean {
  return false;
}

export function validateAccountHolder(
  pdfHolder: string,
  companyLegalName: string,
  entityType: 'INDIVIDUAL' | 'BUSINESS' = 'BUSINESS',
): {
  matches: boolean;
  score: number;
  requiresApproval: boolean;
  method: string;
} {
  if (!pdfHolder || !companyLegalName) {
    return { matches: false, score: 0, requiresApproval: true, method: 'none' };
  }

  const config = loadConfig();
  if (!config.enabled) {
    return { matches: true, score: 1, requiresApproval: false, method: 'disabled' };
  }

  const normPdf = normalize(pdfHolder);
  const normCompany = normalize(companyLegalName);

  if (entityType === 'BUSINESS') {
    const result = bestBusinessScore(
      normPdf,
      normCompany,
      config.businessSuffixes,
      config.thresholds.business,
    );
    return {
      matches: result.meetsThreshold,
      score: result.score,
      requiresApproval: !result.meetsThreshold,
      method: result.method,
    };
  }

  const result = bestIndividualScore(normPdf, normCompany, config.thresholds.individual);
  return {
    matches: result.meetsThreshold,
    score: result.score,
    requiresApproval: !result.meetsThreshold,
    method: result.method,
  };
}
