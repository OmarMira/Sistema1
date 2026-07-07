import { db } from '@/lib/db';
import { existsSync } from 'fs';
import { join } from 'path';

// ── Types ─────────────────────────────────────────────────────────────────

export interface DetectionConfig {
  threshold: number;
  clusterMode: 'fuzzy' | 'exact' | 'hybrid';
  minOccurrences: number;
}

export const DEFAULT_DETECTION_CONFIG: DetectionConfig = {
  threshold: 0.85,
  clusterMode: 'fuzzy',
  minOccurrences: 2,
};

// ── Module-level cache ────────────────────────────────────────────────────

const configCache = new Map<string, DetectionConfig | null>();
let cachePopulated = false;

/**
 * Clear the in-memory cache. Useful for testing or hot-reload scenarios.
 */
export function clearDetectionConfigCache(): void {
  configCache.clear();
  cachePopulated = false;
}

// ── Validation helpers ────────────────────────────────────────────────────

function validateThreshold(value: unknown): number {
  if (typeof value === 'number' && value >= 0.0 && value <= 1.0) return value;
  return DEFAULT_DETECTION_CONFIG.threshold;
}

function validateClusterMode(value: unknown): 'fuzzy' | 'exact' | 'hybrid' {
  if (value === 'fuzzy' || value === 'exact' || value === 'hybrid') return value;
  return DEFAULT_DETECTION_CONFIG.clusterMode;
}

function validateMinOccurrences(value: unknown): number {
  if (typeof value === 'number' && value >= 1 && Number.isInteger(value)) return value;
  return DEFAULT_DETECTION_CONFIG.minOccurrences;
}

function validateAndMerge(
  row: {
    threshold: number | null;
    clusterMode: string | null;
    minOccurrences: number | null;
  } | null,
): DetectionConfig {
  if (!row) return DEFAULT_DETECTION_CONFIG;
  return {
    threshold: validateThreshold(row.threshold),
    clusterMode: validateClusterMode(row.clusterMode),
    minOccurrences: validateMinOccurrences(row.minOccurrences),
  };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Async loader — reads DB per-company override, validates, merges with defaults.
 *
 * When called without a companyId, returns system defaults without touching the DB.
 * Populates the in-memory cache so subsequent sync loads are fast.
 */
export async function loadDetectionConfig(companyId?: string): Promise<DetectionConfig> {
  if (companyId) {
    const row = await db.detectionConfig.findUnique({ where: { companyId } });
    const validated = validateAndMerge(row);
    configCache.set(companyId, validated);
    cachePopulated = true;
    return validated;
  }
  return DEFAULT_DETECTION_CONFIG;
}

/**
 * Sync loader — returns from in-memory cache or defaults.
 *
 * NEVER performs I/O. Safe to call in synchronous contexts.
 * Before the cache has been populated by an async load, this function
 * returns the system defaults without throwing.
 */
export function loadDetectionConfigSync(companyId?: string): DetectionConfig {
  if (!cachePopulated) {
    return DEFAULT_DETECTION_CONFIG;
  }
  if (companyId && configCache.has(companyId)) {
    return configCache.get(companyId)!;
  }
  return DEFAULT_DETECTION_CONFIG;
}

// ── Deprecation check ─────────────────────────────────────────────────────

const DEPRECATED_FILES = [
  'rules/entity-detection.json',
  'rules/learning-engine.json',
  'rules/predictive-recon.json',
];

/**
 * Startup check — logs WARN for each deprecated JSON file found.
 *
 * These files were the previous config sources. The replacement is the
 * DetectionConfig DB table. This function is safe to call at startup;
 * it does NOT read or load the deprecated files.
 */
export function checkDeprecatedConfigFiles(): void {
  for (const filePath of DEPRECATED_FILES) {
    const fullPath = join(process.cwd(), filePath);
    if (existsSync(fullPath)) {
      console.warn(
        `[detection-config] File ${filePath} is deprecated. ` +
        'Use DetectionConfig DB table instead. This file will be removed in a future release.',
      );
    }
  }
}

// ── Module-level deprecation check ────────────────────────────────────────
// Runs once at import time to warn about deprecated JSON config files.
checkDeprecatedConfigFiles();
