import crypto from 'crypto';
import { logger } from '../logger';
import { normalizePattern } from '@/lib/services/pattern-normalizer';

// ========== RE-EXPORT FROM string-similarity ==========
import { jaroWinkler } from '@/lib/utils/string-similarity';
export { jaroWinkler, jaro } from '@/lib/utils/string-similarity';

// ========== INTERFACES TIPIFICADAS (V3.0 Zero-Any) ==========
export interface EntityDetectionConfig {
  sanitization: {
    stripPatterns: Array<{
      name: string;
      regex: string;
      replacement: string;
      flags?: string;
    }>;
  };
  extraction: {
    strategies: Array<{
      priority: number;
      pattern: string;
      description: string;
    }>;
  };
  clustering: {
    algorithm: string;
    threshold: number;
    canonicalSelection: string;
    minLength: number;
    stopWords: string[];
  };
  validation: {
    minOccurrences: number;
    ignorePatterns: string[];
  };
}

export interface BankTransactionRaw {
  description: string;
  amount: number;
  date: string;
  id?: string;
}

export interface EntityCandidate {
  id: string;
  canonicalName: string;
  occurrences: number;
  directionProfile: {
    creditPct: number;
    debitPct: number;
  };
  sampleDescriptions: string[];
  totalAmount?: number;
  hasContext?: boolean;
  contextRole?: string;
  suggestedAccountCode?: string;
  suggestedAccountId?: string;
  confidence?: number;
  confidenceLabel?: 'high' | 'medium' | 'low';
  explanation?: string;
  /** Inferred direction from transaction history: 'credit' | 'debit' */
  direction?: 'credit' | 'debit';
  /** Cluster label for amount ranges (e.g. 'fijo', 'variable') */
  amountCluster?: string;
  /** Human-readable frequency label (e.g. 'mensual', 'único') */
  frequency?: string;
  /** Average transaction amount */
  avgAmount?: number;
  /** Whether this entity has an active FK-linked BankRule */
  isCovered?: boolean;
}

// ========== CACHE DE CONFIGURACIÓN ==========
// Config is now hardcoded (was loaded from rules/entity-detection.json).
// The JSON file is deprecated — use DetectionConfig DB table for overrides.
let cachedConfig: EntityDetectionConfig | null = null;

const DEFAULT_ENTITY_DETECTION_CONFIG: EntityDetectionConfig = {
  sanitization: {
    stripPatterns: [
      { name: 'remove_zelle_memos', regex: '\\bfor\\b.*', replacement: '', flags: 'gi' },
      { name: 'remove_conf_ref_ids', regex: '(Conf#|Ref#|ID:|ID: Indn:|TRX)\\s*\\S*|\\b\\d{10,}\\b|\\$[\\d,]+\\.\\d{2}|\\b(?:[A-Za-z]+\\d+[A-Za-z0-9]*|\\d+[A-Za-z]+[A-Za-z0-9]*)\\b', replacement: '', flags: 'gi' },
      { name: 'remove_dates', regex: '\\b\\d{1,2}[\\/\\-\\.]\\d{1,2}[\\/\\-\\.]\\d{2,4}\\b', replacement: '' },
      { name: 'remove_banks_prefixes', regex: '\\b(BKOFAMERICA|DEPOSIT|MOBILE|PAYMENT|TRANSFER|Zelle payment)\\b', replacement: '', flags: 'gi' },
      { name: 'remove_descriptors', regex: '(DES:|WEB|CCD|PMT INFO:[^\\s]+)', replacement: '', flags: 'gi' },
    ],
  },
  extraction: {
    strategies: [
      { priority: 1, pattern: '^(RAISER\\s*\\d*|LYFT[\\*\\.]?COM|TURO\\s*\\d*|AMERICAN\\s*EXPRESS|SETOYOTA\\s*FIN[\\/\\w]*|HOME\\s*DEPOT|KMF[\\w\\.]*|UBER\\s*USA\\s*\\d*|RIDELYFT)\\b', description: 'Captura nombres de empresas con variantes numéricas y de formato al inicio de la descripción.' },
      { priority: 2, pattern: '\\b(?:from|to|payee)\\s+([A-ZÀ-ÿ0-9\\s\\.&\\-\']{2,40})', description: 'Busca nombre tras from, to o payee.' },
      { priority: 3, pattern: '\\bINDN:\\s*([A-ZÀ-ÿ0-9\\s\\.&\\-\']+?)(?=\\s+(?:CO ID:|ID:|CCD|WEB)|$)', description: 'Busca nombre tras INDN: hasta marcador técnico.' },
      { priority: 1, pattern: '^([A-ZÀ-ÿ0-9\\s\\.\\,&\\-\']{2,40})(?=\\s+(DES:|ID:|\\d{2}\\/))', description: 'Fallback: Primera secuencia de texto largo antes de un descriptor técnico.' },
    ],
  },
  clustering: {
    algorithm: 'jaro-winkler',
    threshold: 0.85,
    canonicalSelection: 'most_frequent',
    minLength: 3,
    stopWords: ['LLC', 'INC', 'CORP', 'CO', 'PA', 'THE', 'AND', 'DES', 'PMNT'],
  },
  validation: {
    minOccurrences: 2,
    ignorePatterns: ['CASH', 'CHECK', 'FEE', 'INTEREST', 'BALANCE', 'MOBILE'],
  },
};

export function loadConfig(): EntityDetectionConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = { ...DEFAULT_ENTITY_DETECTION_CONFIG };
  return cachedConfig;
}

// ========== PRE-PROCESSING + SANITIZACIÓN ==========

/**
 * Applies configured strip patterns for entity detection.
 * This runs BEFORE name extraction — preserves case and most punctuation
 * so that extraction regexes can match against the original text format.
 * normalizePattern() is applied later for cluster key generation.
 */
export function preprocessForEntityDetection(desc: string, config: EntityDetectionConfig): string {
  let cleaned = desc;
  for (const pattern of config.sanitization.stripPatterns) {
    try {
      const flags = pattern.flags || 'gi';
      const rx = new RegExp(pattern.regex, flags);
      cleaned = cleaned.replace(rx, pattern.replacement ?? '');
    } catch (err) {
      logger.warn('ENTITY_DETECTOR_INVALID_REGEX', { pattern: pattern.name, error: String(err) });
    }
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

/**
 * Sanitizes a bank description for entity detection.
 * Step 1: Pre-process with configured strip patterns (preserves case/punctuation).
 * normalizePattern() is applied separately at the key-generation stage
 * (see clusterExact) to avoid breaking regex-based extraction.
 */
export function sanitizeDescription(desc: string, config: EntityDetectionConfig): string {
  return preprocessForEntityDetection(desc, config);
}

// ========== COMPONENTES DE EXTRACCIÓN (TODAS LAS ESTRATEGIAS) ==========
export interface ExtractedComponents {
  merchant: string | null; // P1: merchant at line start
  transferName: string | null; // P2: from/to transfer name
  indnName: string | null; // P3: INDN: ACH individual
}

export function extractComponents(
  desc: string,
  config: EntityDetectionConfig,
): ExtractedComponents {
  const result: ExtractedComponents = { merchant: null, transferName: null, indnName: null };
  const strategies = [...config.extraction.strategies].sort((a, b) => a.priority - b.priority);

  for (const strategy of strategies) {
    try {
      const rx = new RegExp(strategy.pattern, 'i');
      const match = desc.match(rx);
      if (match) {
        const extracted = (match[1] || match[0]).trim();
        if (extracted.length >= config.clustering.minLength) {
          if (strategy.priority === 1) result.merchant = extracted;
          else if (strategy.priority === 2) result.transferName = extracted;
          else if (strategy.priority === 3) result.indnName = extracted;
        }
      }
    } catch (err) {
      logger.warn('EXTRACT_COMPONENTS_INVALID_STRATEGY', { error: String(err) });
    }
  }

  return result;
}

// ========== EXTRACCIÓN CON ESTRATEGIAS PRIORIZADAS ==========
export function extractName(desc: string, config: EntityDetectionConfig): string | null {
  const strategies = [...config.extraction.strategies].sort((a, b) => a.priority - b.priority);

  for (const strategy of strategies) {
    try {
      const rx = new RegExp(strategy.pattern, 'i');
      const match = desc.match(rx);
      if (match) {
        const extracted = (match[1] || match[0]).trim();
        if (extracted.length >= config.clustering.minLength) {
          return extracted;
        }
      }
    } catch (err) {
      logger.warn('ENTITY_DETECTOR_INVALID_STRATEGY', { error: String(err) });
    }
  }
  return null;
}

// ========== CLUSTER OPTIONS ==========
export interface ClusterOptions {
  mode?: 'fuzzy' | 'exact';
  threshold?: number;
  minOccurrences?: number;
  minLength?: number;
  smartFrequency?: boolean;
  extraNumberStrip?: boolean;
  requireRole?: boolean;
}

// ========== CLUSTERING PRINCIPAL: DISPATCH BY MODE ==========
// ========== CLUSTER BY BEHAVIOR (WIZARD FLOW) ==========
export function clusterByBehavior(
  transactions: BankTransactionRaw[],
  config: EntityDetectionConfig,
): EntityCandidate[] {
  return clusterCandidates(transactions, config, {
    mode: 'exact',
    extraNumberStrip: true,
    smartFrequency: true,
  });
}

export function clusterCandidates(
  transactions: BankTransactionRaw[],
  config: EntityDetectionConfig,
  options?: ClusterOptions,
): EntityCandidate[] {
  const mode = options?.mode ?? 'fuzzy';

  if (mode === 'exact') {
    return clusterExact(transactions, config, options);
  }

  return clusterFuzzy(transactions, config, options);
}

// ========== MODO EXACTO: AGRUPACIÓN POR LLAVE NORMALIZADA ==========
function clusterExact(
  transactions: BankTransactionRaw[],
  config: EntityDetectionConfig,
  options?: ClusterOptions,
): EntityCandidate[] {
  const effectiveMinOccurrences = options?.minOccurrences ?? config.validation.minOccurrences;
  const effectiveMinLength = options?.minLength ?? config.clustering.minLength;
  const { stopWords } = config.clustering;
  const { ignorePatterns } = config.validation;

  const candidatesMap = new Map<
    string,
    {
      names: string[];
      count: number;
      credits: number;
      debits: number;
      samples: Set<string>;
      totalAmount: number;
    }
  >();

  for (const tx of transactions) {
    // Skip zero-amount transactions (epsilon-safe for Prisma Decimal)
    if (Math.abs(Number(tx.amount)) < 0.00001) continue;
    let cleaned = sanitizeDescription(tx.description, config);

    // Apply extraNumberStrip BEFORE extraction if enabled
    if (options?.extraNumberStrip) {
      cleaned = cleaned.replace(/\b\d[\d.,\/-]*\b/g, '').replace(/\s{2,}/g, ' ').trim();
    }

    const name = extractName(cleaned, config);
    if (!name) continue;

    const nameUpper = name.toUpperCase();
    if (name.length < effectiveMinLength) continue;

    if (ignorePatterns.some((p) => new RegExp(`\\b${p}\\b`, 'i').test(nameUpper))) continue;
    if (stopWords.some((sw) => nameUpper === sw.toUpperCase())) continue;

    // Normalized key for exact matching (numbers always stripped, then canonical normalization)
    const key = normalizePattern(name.replace(/\b\d[\d.,\/-]*\b/g, ''));

    if (!key) continue; // skip if key is empty after stripping

    const absAmount = Math.abs(tx.amount);
    const isCredit = tx.amount > 0;
    if (candidatesMap.has(key)) {
      const cluster = candidatesMap.get(key)!;
      cluster.names.push(name);
      cluster.count++;
      cluster.totalAmount += absAmount;
      if (isCredit) cluster.credits++;
      else cluster.debits++;
      if (cluster.samples.size < 5) cluster.samples.add(tx.description);
    } else {
      candidatesMap.set(key, {
        names: [name],
        count: 1,
        credits: isCredit ? 1 : 0,
        debits: isCredit ? 0 : 1,
        samples: new Set([tx.description]),
        totalAmount: absAmount,
      });
    }
  }

  return buildCandidatesFromMap(candidatesMap, effectiveMinOccurrences);
}

// ========== MODO FUZZY: JARO-WINKLER ORIGINAL (BACKWARD COMPATIBLE) ==========
function clusterFuzzy(
  transactions: BankTransactionRaw[],
  config: EntityDetectionConfig,
  _options?: ClusterOptions,
): EntityCandidate[] {
  const candidatesMap = new Map<
    string,
    {
      names: string[];
      count: number;
      credits: number;
      debits: number;
      samples: Set<string>;
    }
  >();

  const { stopWords, minLength, threshold } = config.clustering;
  const { minOccurrences, ignorePatterns } = config.validation;

  for (const tx of transactions) {
    // Skip zero-amount transactions (epsilon-safe for Prisma Decimal)
    if (Math.abs(Number(tx.amount)) < 0.00001) continue;
    const cleaned = sanitizeDescription(tx.description, config);
    const name = extractName(cleaned, config);
    if (!name) continue;

    const nameUpper = name.toUpperCase();
    if (name.length < minLength) continue;

    if (ignorePatterns.some((p) => new RegExp(`\\b${p}\\b`, 'i').test(nameUpper))) continue;
    if (stopWords.some((sw) => nameUpper === sw.toUpperCase())) continue;

    let foundClusterKey: string | null = null;
    for (const key of candidatesMap.keys()) {
      if (jaroWinkler(nameUpper, key) >= threshold) {
        foundClusterKey = key;
        break;
      }
    }

    const isCredit = tx.amount > 0;
    if (foundClusterKey) {
      const cluster = candidatesMap.get(foundClusterKey)!;
      cluster.names.push(name);
      cluster.count++;
      if (isCredit) cluster.credits++;
      else cluster.debits++;
      if (cluster.samples.size < 5) cluster.samples.add(tx.description);
    } else {
      candidatesMap.set(nameUpper, {
        names: [name],
        count: 1,
        credits: isCredit ? 1 : 0,
        debits: isCredit ? 0 : 1,
        samples: new Set([tx.description]),
      });
    }
  }

  return buildCandidatesFromMap(candidatesMap, minOccurrences);
}

// ========== CONSTRUIR RESULTADOS DESDE MAPA DE CLUSTERS (COMPARTIDO) ==========
function buildCandidatesFromMap(
  candidatesMap: Map<string, { names: string[]; count: number; credits: number; debits: number; samples: Set<string>; totalAmount?: number }>,
  minOccurrences: number,
): EntityCandidate[] {
  const result: EntityCandidate[] = [];
  for (const [key, cluster] of candidatesMap.entries()) {
    if (cluster.count < minOccurrences) continue;

    const nameCounts: Record<string, number> = {};
    let canonicalName = cluster.names[0];
    let maxCount = 0;
    for (const name of cluster.names) {
      nameCounts[name] = (nameCounts[name] || 0) + 1;
      if (nameCounts[name] > maxCount) {
        maxCount = nameCounts[name];
        canonicalName = name;
      }
    }

    const total = cluster.count;
    const creditPct = total > 0 ? cluster.credits / total : 0;
    const debitPct = total > 0 ? cluster.debits / total : 0;

    result.push({
      id: crypto.createHash('sha256').update(canonicalName).digest('hex').slice(0, 12),
      canonicalName,
      occurrences: total,
      directionProfile: { creditPct, debitPct },
      sampleDescriptions: Array.from(cluster.samples),
      totalAmount: cluster.totalAmount,
    });
  }

  return result;
}
