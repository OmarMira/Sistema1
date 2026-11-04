import path from 'path';
import { configuredDataRoot } from '../backup-maintenance.mjs';

// Optional installed-instance storage; unset keeps the original development paths.
export const DATA_ROOT = configuredDataRoot();
export const RUNTIME_DIR = DATA_ROOT ? path.join(DATA_ROOT, 'config') : path.join(process.cwd(), '.data');
export const BACKUP_DIR = DATA_ROOT ? path.join(DATA_ROOT, 'backups') : path.join(process.cwd(), 'db', 'backups');

// companyConfig remains included in the existing backup/restore contract.
export const RUNTIME_FILES = {
  companyConfig: path.join(RUNTIME_DIR, 'company-config.json'),
} as const;

export const LEGACY_FILES = {
  companyConfig: path.join(process.cwd(), 'rules', 'company-config.json'),
} as const;

export const DEFAULT_TEMPLATES = {
  companyConfig: path.join(process.cwd(), 'rules', 'defaults', 'company-config.default.json'),
} as const;
