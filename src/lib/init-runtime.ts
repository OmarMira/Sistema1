import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR, RUNTIME_FILES, LEGACY_FILES, DEFAULT_TEMPLATES } from '@/lib/config/paths';
import { logger } from '@/lib/logger';

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function migrateLegacy(legacyPath: string, runtimePath: string): void {
  if (fs.existsSync(legacyPath) && !fs.existsSync(runtimePath)) {
    ensureDir(path.dirname(runtimePath));
    fs.copyFileSync(legacyPath, runtimePath);
    logger.info('[RUNTIME] Migrated legacy file to runtime directory', {
      from: legacyPath,
      to: runtimePath,
    });
  }
}

function initFromDefault(templatePath: string, targetPath: string): void {
  if (!fs.existsSync(targetPath)) {
    ensureDir(path.dirname(targetPath));
    if (fs.existsSync(templatePath)) {
      fs.copyFileSync(templatePath, targetPath);
      logger.info('[RUNTIME] Initialized from default template', { target: targetPath });
    } else {
      fs.writeFileSync(targetPath, '', 'utf-8');
      logger.info('[RUNTIME] Created empty runtime file', { target: targetPath });
    }
  }
}

export function initRuntimeData(): void {
  ensureDir(RUNTIME_DIR);

  // 1. Migrate legacy files first (they take priority over defaults)
  migrateLegacy(LEGACY_FILES.companyConfig, RUNTIME_FILES.companyConfig);
  migrateLegacy(LEGACY_FILES.learningEvents, RUNTIME_FILES.learningEvents);

  // 2. Init from defaults only if no runtime file exists yet
  initFromDefault(DEFAULT_TEMPLATES.companyConfig, RUNTIME_FILES.companyConfig);
  initFromDefault('', RUNTIME_FILES.learningEvents);

  logger.info('[RUNTIME] Initialization complete', { dir: RUNTIME_DIR });
}
