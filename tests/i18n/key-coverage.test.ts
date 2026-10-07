import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import es from '@/i18n/locales/es';
import en from '@/i18n/locales/en';

// Regression guard: every literal t('...') key used by the components touched
// in this workstream must exist in BOTH locales. The translator falls back to
// the raw key on a miss (getTranslation(..., key, key)), so a missing key
// leaks e.g. "common.close" straight into the UI as untranslated text.

const FILES = [
  'src/components/spa/BankRulesPage.tsx',
  'src/components/import/UncategorizedReviewDialog.tsx',
  'src/components/import/AiProposalSection.tsx',
  'src/components/import/ReclassifyDialog.tsx',
  'src/components/import/ImportResultDialog.tsx',
  'src/components/spa/ImportPage.tsx',
  'src/components/spa/DashboardPage.tsx',
  'src/components/dashboard/DashboardPageBlocks.tsx',
  'src/components/spa/UtcEducationalModal.tsx',
  'src/components/reports/ReportExportModal.tsx',
  'src/components/assistant/ChatView.tsx',
  'src/components/budget/BudgetVarianceReport.tsx',
  'src/components/ui/address-autocomplete.tsx',
];

function resolve(locale: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], locale);
}

describe('i18n key coverage for touched components', () => {
  it.each(FILES)('%s: literal t() keys resolve in es and en', (file) => {
    const src = readFileSync(join(process.cwd(), file), 'utf8');
    const keys = new Set([...src.matchAll(/\bt\(\s*(['"])([^'"]+)\1/g)].map((m) => m[2]));
    const missing: string[] = [];
    for (const key of keys) {
      if (typeof resolve(es, key) !== 'string') missing.push(`${key} [es]`);
      if (typeof resolve(en, key) !== 'string') missing.push(`${key} [en]`);
    }
    expect(missing, `missing locale keys in ${file}`).toEqual([]);
  });
});
