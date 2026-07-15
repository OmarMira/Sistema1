import path from 'path';

export const RUNTIME_DIR = path.join(process.cwd(), '.data');

// Runtime files: separated from source to survive rebuilds.
// companyConfig → INCLUDED in backup/restore (stores currency, periodType per company).
// learningEvents → EXCLUDED from backup (transient feedback log; extracted knowledge
//   persists via bank_rules in the DB, which IS part of backup).
export const RUNTIME_FILES = {
  companyConfig: path.join(RUNTIME_DIR, 'company-config.json'),
  learningEvents: path.join(RUNTIME_DIR, 'learning-events.jsonl'),
} as const;

export const LEGACY_FILES = {
  companyConfig: path.join(process.cwd(), 'rules', 'company-config.json'),
  learningEvents: path.join(process.cwd(), 'rules', 'learning-events.jsonl'),
} as const;

export const DEFAULT_TEMPLATES = {
  companyConfig: path.join(process.cwd(), 'rules', 'defaults', 'company-config.default.json'),
} as const;
