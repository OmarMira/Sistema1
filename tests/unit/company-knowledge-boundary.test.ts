import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import { localRules } from '../../eslint.config.mjs';

const RULE_ID = 'local/no-server-import-in-client';

function lint(source: string): string[] {
  const linter = new Linter();
  const messages = linter.verify(source, {
    plugins: {
      local: { rules: localRules as never },
    },
    rules: {
      [RULE_ID]: 'error',
    },
  });
  return messages.map((m) => m.message);
}

describe('no-server-import-in-client', () => {
  it('blocks a Client Component importing /server', () => {
    const source = `'use client';\nimport { archive } from '@/internal/company-knowledge/server';\n`;
    const messages = lint(source);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('server-only');
  });

  it('blocks a Client Component importing the server barrel', () => {
    const source = `'use client';\nimport { archive } from '@/internal/company-knowledge';\n`;
    const messages = lint(source);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('server-only');
  });

  it('blocks a Client Component importing an explicit server subpath', () => {
    const source = `'use client';\nimport { archive } from '@/internal/company-knowledge/entity/service';\n`;
    const messages = lint(source);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('server-only');
  });

  it('allows a Server Component importing /server', () => {
    const source = `import { archive } from '@/internal/company-knowledge/server';\n`;
    const messages = lint(source);
    expect(messages).toHaveLength(0);
  });

  it('allows an API route importing /server', () => {
    const source = `import { archive } from '@/internal/company-knowledge/server';\n`;
    const messages = lint(source);
    expect(messages).toHaveLength(0);
  });

  it('allows a Client Component importing the client-safe surface', () => {
    const source = `'use client';\nimport { EntityTypeValues } from '@/internal/company-knowledge/client';\n`;
    const messages = lint(source);
    expect(messages).toHaveLength(0);
  });
});