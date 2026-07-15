import { appendFile, mkdir, rename, writeFile, readFile, stat } from 'fs/promises';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';
import { normalizePattern } from '@/lib/services/pattern-normalizer';
import { RUNTIME_FILES } from '@/lib/config/paths';
import { logger } from '@/lib/logger';

export type FeedbackEvent = {
  timestamp: string;
  bankDescription: string;
  selectedGlAccountCode: string;
  confidence: number; // 0-1
  userId: string;
  companyId: string;
  amount?: number; // Optional transaction amount
};

/**
 * Computes a deterministic hash for a bank description to use in dedup checks.
 * Normalizes casing and trims whitespace before hashing.
 */
export function computeDescriptionHash(description: string): string {
  return createHash('sha256').update(description.toLowerCase().trim()).digest('hex');
}

const descriptionHashes = new Set<string>();

export async function recordFeedback(event: FeedbackEvent) {
  const logPath = RUNTIME_FILES.learningEvents;

  await mkdir(dirname(logPath), { recursive: true });

  // Rotate log if it exceeds 5MB
  try {
    const stats = await stat(logPath);
    const maxSize = 5 * 1024 * 1024;
    if (stats.size > maxSize) {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const dir = dirname(logPath);
      const archivePath = join(dir, `learning-events-archive-${timestamp}.jsonl`);
      await rename(logPath, archivePath);
      await writeFile(logPath, '', 'utf-8');
      descriptionHashes.clear();
    }
  } catch {
    // File doesn't exist or rotation skipped — proceed
  }

  const descHash = computeDescriptionHash(event.bankDescription);
  if (descriptionHashes.has(descHash)) {
    logger.info('[ADAPTIVE] Duplicate feedback skipped (in-memory)', {
      hash: descHash,
      description: event.bankDescription,
    });
    return;
  }

  descriptionHashes.add(descHash);
  await appendFile(logPath, JSON.stringify(event) + '\n', 'utf-8');
}

/**
 * Pre-processes a bank description for adaptive learning.
 * Applies noise removal and stop word filtering BEFORE canonical normalization.
 */
function preprocessForAdaptive(
  desc: string,
  config: {
    sanitizeNoise: Record<string, string>;
    patternGeneration: { ignoreStopWords: string[] };
  },
): string {
  let cleaned = desc.toLowerCase().trim();
  if (config.sanitizeNoise) {
    for (const pattern of Object.values(config.sanitizeNoise)) {
      const rx = new RegExp(pattern as string, 'gi');
      cleaned = cleaned.replace(rx, ' ');
    }
  }
  const words = cleaned.split(/\s+/).filter(Boolean);
  const filtered = words.filter((w) => !config.patternGeneration.ignoreStopWords.includes(w));
  return filtered.join(' ').trim();
}

export function generateCandidateRules(companyId: string) {
  const logPath = RUNTIME_FILES.learningEvents;
  const config: {
    minOccurrencesToGenerateRule: number;
    consistencyScoreThreshold: number;
    sanitizeNoise: Record<string, string>;
    patternGeneration: { ignoreStopWords: string[] };
  } = {
    minOccurrencesToGenerateRule: 3,
    consistencyScoreThreshold: 0.85,
    sanitizeNoise: {
      dates: '\\d{1,2}[\\/\\-\\.]\\d{1,2}[\\/\\-\\.]\\d{2,4}',
      references: '(Ref|Conf|Trx|#)\\s*[\\w\\d]+',
      amounts: '\\b\\d[\\d.,/\\-]*\\b',
    },
    patternGeneration: {
      ignoreStopWords: ['to', 'from', 'payment', 'ach', 'zelle', 'conf', 'id'],
    },
  };

  const allEvents: FeedbackEvent[] = [];

  // Read active log
  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        allEvents.push(JSON.parse(line));
      } catch (e) {
        logger.info('[ADAPTIVE] Skipping malformed log line', { line: line.slice(0, 100) });
      }
    }
  }

  // Scan and read rotated archives in the last 30 days
  const logDir = dirname(logPath);
  if (existsSync(logDir)) {
    try {
      const files = readdirSync(logDir);
      const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

      for (const file of files) {
        if (file.startsWith('learning-events-archive-') && file.endsWith('.jsonl')) {
          const filePath = join(logDir, file);
          try {
            const stats = statSync(filePath);
            const createdTime =
              stats.birthtimeMs ||
              stats.birthtime?.getTime() ||
              stats.mtimeMs ||
              stats.mtime?.getTime() ||
              Date.now();
            if (createdTime >= thirtyDaysAgo) {
              const lines = readFileSync(filePath, 'utf-8').trim().split('\n').filter(Boolean);
              for (const line of lines) {
                try {
                  allEvents.push(JSON.parse(line));
                } catch (e) {
                  logger.info('[ADAPTIVE] Skipping malformed archive line', { file, line: line.slice(0, 100) });
                }
              }
            }
          } catch (err) {
            logger.info('[ADAPTIVE] Skipping unreadable archive file', { file, error: String(err) });
          }
        }
      }
    } catch (err) {
      logger.info('[ADAPTIVE] Archive directory scan failed', { error: String(err) });
    }
  }

  const companyEvents = allEvents.filter((e) => e.companyId === companyId);

  // Group by sanitized pattern
  const patternGroups: Record<string, { events: FeedbackEvent[]; count: number }> = {};

  for (const e of companyEvents) {
    const preprocessed = preprocessForAdaptive(e.bankDescription, config);
    const patternKey = normalizePattern(preprocessed);
    if (patternKey.length < 3) continue;

    if (!patternGroups[patternKey]) {
      patternGroups[patternKey] = { events: [], count: 0 };
    }
    patternGroups[patternKey].events.push(e);
    patternGroups[patternKey].count++;
  }

  interface AdaptiveCandidate {
    id: string;
    pattern: string;
    glAccountCode: string;
    confidence: number;
    occurrences: number;
    direction: 'debit' | 'credit' | 'any';
    priority: number;
    status: string;
  }

  const candidates: AdaptiveCandidate[] = [];

  for (const [pattern, data] of Object.entries(patternGroups)) {
    if (data.count < config.minOccurrencesToGenerateRule) continue;

    // Check Account Consistency Score
    const accountCounts: Record<string, number> = {};
    let debitCount = 0;
    let creditCount = 0;

    data.events.forEach((ev) => {
      accountCounts[ev.selectedGlAccountCode] = (accountCounts[ev.selectedGlAccountCode] || 0) + 1;
      if (ev.amount !== undefined) {
        if (ev.amount < 0) debitCount++;
        else creditCount++;
      }
    });

    // Find most common account
    let bestAccount = '';
    let maxCount = 0;
    for (const [code, cnt] of Object.entries(accountCounts)) {
      if (cnt > maxCount) {
        maxCount = cnt;
        bestAccount = code;
      }
    }

    const consistencyScore = maxCount / data.count;
    const threshold = config.consistencyScoreThreshold || 0.85;

    // Discard if inconsistent
    if (consistencyScore < threshold) continue;

    // Determine direction lock
    let direction: 'debit' | 'credit' | 'any' = 'any';
    if (debitCount > 0 && creditCount === 0) {
      direction = 'debit';
    } else if (creditCount > 0 && debitCount === 0) {
      direction = 'credit';
    } else if (debitCount > 0 && creditCount > 0) {
      // Mixed signs -> discard or manual review
      continue;
    }

    // Dynamic priority: longer/more specific patterns get lower priority numbers (higher execution order)
    const priority = Math.max(1, Math.min(19, 20 - Math.floor(pattern.length / 3)));

    candidates.push({
      id: createHash('sha256').update(`${bestAccount}-${pattern}`).digest('hex').slice(0, 12),
      pattern: `(?i)${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, // Safe regex
      glAccountCode: bestAccount,
      confidence: consistencyScore,
      occurrences: data.count,
      direction,
      priority,
      status: 'pending_review',
    });
  }

  return candidates;
}
