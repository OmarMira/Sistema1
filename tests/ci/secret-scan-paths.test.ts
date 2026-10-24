import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync('.gitleaks.toml', 'utf8');
const paths = config.match(/paths = \[([\s\S]*?)\n\]/)![1];
const exclusions = [...paths.matchAll(/'''([^']+)'''/g)].map(match => new RegExp(match[1]));
const excluded = (file: string) => exclusions.some(pattern => pattern.test(file));

describe('secret-scan path scope', () => {
  it.each(['.next/dev/lock', '.next\\dev\\lock', 'node_modules/pkg/index.js', 'node_modules\\pkg\\index.js'])('retains the existing generated-directory exclusion for %s', (file) => {
    expect(excluded(file)).toBe(true);
  });
  it.each(['src/lib/config.ts', '.env.recovered', '.env.clean_identity', '.nextish/config.js', 'node_modules-backup/key.txt'])('does not hide source or unclassified backup %s', (file) => {
    expect(excluded(file)).toBe(false);
  });
});
