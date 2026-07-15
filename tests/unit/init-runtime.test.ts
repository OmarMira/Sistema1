import { describe, it, expect, vi, beforeEach } from 'vitest';

const RUNTIME_DIR = '/.data';
const RUNTIME_COMPANY_CONFIG = '/.data/company-config.json';
const RUNTIME_LEARNING_EVENTS = '/.data/learning-events.jsonl';
const LEGACY_COMPANY_CONFIG = '/rules/company-config.json';
const LEGACY_LEARNING_EVENTS = '/rules/learning-events.jsonl';
const DEFAULT_COMPANY_CONFIG = '/rules/defaults/company-config.default.json';

vi.mock('@/lib/config/paths', () => ({
  RUNTIME_DIR,
  RUNTIME_FILES: {
    companyConfig: RUNTIME_COMPANY_CONFIG,
    learningEvents: RUNTIME_LEARNING_EVENTS,
  },
  LEGACY_FILES: {
    companyConfig: LEGACY_COMPANY_CONFIG,
    learningEvents: LEGACY_LEARNING_EVENTS,
  },
  DEFAULT_TEMPLATES: {
    companyConfig: DEFAULT_COMPANY_CONFIG,
  },
}));

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type FileSystem = Record<string, string | undefined>;
const fsFiles: FileSystem = {};

vi.mock('fs', () => {
  const actual = { default: {} } as any;
  actual.default.existsSync = vi.fn((p: string) => fsFiles[p] !== undefined);
  actual.default.mkdirSync = vi.fn(() => {});
  actual.default.copyFileSync = vi.fn((src: string, dest: string) => {
    if (fsFiles[src] !== undefined) {
      fsFiles[dest] = fsFiles[src];
    }
  });
  actual.default.writeFileSync = vi.fn((p: string, content: string) => {
    fsFiles[p] = content;
  });
  return actual;
});

describe('initRuntimeData', () => {
  let initRuntimeData: () => void;

  beforeEach(() => {
    vi.resetModules();
    for (const key of Object.getOwnPropertyNames(fsFiles)) {
      delete fsFiles[key];
    }
  });

  it('1. legacy exists + runtime missing → copies legacy to .data', async () => {
    fsFiles[LEGACY_COMPANY_CONFIG] = '{"companies":{"c1":{"currency":"USD"}}}';
    fsFiles[LEGACY_LEARNING_EVENTS] = '{"event":"a"}\n';

    initRuntimeData = (await import('@/lib/init-runtime')).initRuntimeData;
    initRuntimeData();

    expect(fsFiles[RUNTIME_COMPANY_CONFIG]).toBe('{"companies":{"c1":{"currency":"USD"}}}');
    expect(fsFiles[RUNTIME_LEARNING_EVENTS]).toBe('{"event":"a"}\n');
  });

  it('2. runtime exists → does NOT overwrite with legacy or template', async () => {
    fsFiles[RUNTIME_COMPANY_CONFIG] = '{"companies":{"c2":{"currency":"EUR"}}}';
    fsFiles[RUNTIME_LEARNING_EVENTS] = 'keep me';
    fsFiles[LEGACY_COMPANY_CONFIG] = '{"companies":{"c1":{"currency":"USD"}}}';
    fsFiles[LEGACY_LEARNING_EVENTS] = 'do not touch';

    initRuntimeData = (await import('@/lib/init-runtime')).initRuntimeData;
    initRuntimeData();

    expect(fsFiles[RUNTIME_COMPANY_CONFIG]).toBe('{"companies":{"c2":{"currency":"EUR"}}}');
    expect(fsFiles[RUNTIME_LEARNING_EVENTS]).toBe('keep me');
  });

  it('3. no legacy, no runtime → creates company-config from default template', async () => {
    fsFiles[DEFAULT_COMPANY_CONFIG] = '{"companies":{}}';

    initRuntimeData = (await import('@/lib/init-runtime')).initRuntimeData;
    initRuntimeData();

    expect(fsFiles[RUNTIME_COMPANY_CONFIG]).toBe('{"companies":{}}');
  });

  it('4. no legacy, no runtime → creates empty JSONL for learning events', async () => {
    initRuntimeData = (await import('@/lib/init-runtime')).initRuntimeData;
    initRuntimeData();

    expect(fsFiles[RUNTIME_LEARNING_EVENTS]).toBe('');
  });

  it('5. calling initRuntimeData() twice is idempotent', async () => {
    fsFiles[DEFAULT_COMPANY_CONFIG] = '{"companies":{}}';
    fsFiles[LEGACY_COMPANY_CONFIG] = '{"companies":{"c1":{"currency":"USD"}}}';

    initRuntimeData = (await import('@/lib/init-runtime')).initRuntimeData;
    initRuntimeData();
    const afterFirst = { ...fsFiles };
    initRuntimeData();
    const afterSecond = { ...fsFiles };

    expect(afterSecond[RUNTIME_COMPANY_CONFIG]).toBe(afterFirst[RUNTIME_COMPANY_CONFIG]);
    expect(afterSecond[RUNTIME_LEARNING_EVENTS]).toBe(afterFirst[RUNTIME_LEARNING_EVENTS]);
  });

  it('6. migration does NOT delete the legacy file', async () => {
    fsFiles[LEGACY_COMPANY_CONFIG] = '{"companies":{"c1":{"currency":"USD"}}}';
    fsFiles[LEGACY_LEARNING_EVENTS] = '{"event":"a"}\n';

    initRuntimeData = (await import('@/lib/init-runtime')).initRuntimeData;
    initRuntimeData();

    expect(fsFiles[LEGACY_COMPANY_CONFIG]).toBe('{"companies":{"c1":{"currency":"USD"}}}');
    expect(fsFiles[LEGACY_LEARNING_EVENTS]).toBe('{"event":"a"}\n');
  });

});
