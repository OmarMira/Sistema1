import path from 'path';

export const RUNTIME_DIR = path.join(process.cwd(), '.data');

// Runtime files: separated from source to survive rebuilds.
// companyConfig → INCLUDED in backup/restore (stores currency, periodType per company).
export const RUNTIME_FILES = {
  companyConfig: path.join(RUNTIME_DIR, 'company-config.json'),
} as const;

export const LEGACY_FILES = {
  companyConfig: path.join(process.cwd(), 'rules', 'company-config.json'),
} as const;

export const DEFAULT_TEMPLATES = {
  companyConfig: path.join(process.cwd(), 'rules', 'defaults', 'company-config.default.json'),
} as const;
