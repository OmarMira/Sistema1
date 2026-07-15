import { describe, it, expect, vi, beforeEach } from 'vitest';

// Initialize global files database — same pattern as the rotation test
(globalThis as any)._fsFiles = {};

const defaultEngineConfig = JSON.stringify({
  version: '1.0',
  feedbackLogPath: 'rules/learning-events.jsonl',
  minConfidenceToAutoSuggest: 0.85,
  minOccurrencesToGenerateRule: 3,
  consistencyScoreThreshold: 0.85,
  sanitizeNoise: {
    dates: '\\d{1,2}[\\/\\-\\.]\\d{1,2}[\\/\\-\\.]\\d{2,4}',
  },
  patternGeneration: {
    ignoreStopWords: ['to', 'from', 'payment', 'ach'],
  },
});

const normalizePath = (p: string) => {
  let clean = p.replace(/\\/g, '/');
  if (clean.length > 1 && clean.endsWith('/')) {
    clean = clean.slice(0, -1);
  }
  const rulesIndex = clean.indexOf('rules');
  if (rulesIndex !== -1) {
    return clean.slice(rulesIndex);
  }
  const dataIndex = clean.indexOf('.data');
  if (dataIndex !== -1) {
    return clean.slice(dataIndex);
  }
  return clean;
};

// ─── Mock fs ───────────────────────────────────────────────────────────────────
vi.mock('fs', () => {
  return {
    existsSync: vi.fn((path: string) => {
      const key = normalizePath(path);
      const files = (globalThis as any)._fsFiles || {};
      if (files[key] !== undefined) return true;
      const dirPrefix = key.endsWith('/') ? key : key + '/';
      return Object.keys(files).some((k) => k.startsWith(dirPrefix));
    }),
    readFileSync: vi.fn((path: string) => {
      const key = normalizePath(path);
      const files = (globalThis as any)._fsFiles || {};
      if (!files[key]) throw new Error('File not found: ' + path + ' (key: ' + key + ')');
      return files[key];
    }),
    writeFileSync: vi.fn((path: string, content: string) => {
      const key = normalizePath(path);
      const files = (globalThis as any)._fsFiles || {};
      files[key] = content;
    }),
    appendFileSync: vi.fn((path: string, content: string) => {
      const key = normalizePath(path);
      const files = (globalThis as any)._fsFiles || {};
      files[key] = (files[key] || '') + content;
    }),
    mkdirSync: vi.fn(() => {}),
    renameSync: vi.fn((oldPath: string, newPath: string) => {
      const oldKey = normalizePath(oldPath);
      const newKey = normalizePath(newPath);
      const files = (globalThis as any)._fsFiles || {};
      if (files[oldKey] !== undefined) {
        files[newKey] = files[oldKey];
        delete files[oldKey];
      }
    }),
    statSync: vi.fn((path: string) => {
      const key = normalizePath(path);
      const files = (globalThis as any)._fsFiles || {};
      const content = files[key] || '';
      return {
        size: content.length,
        birthtimeMs: Date.now(),
        birthtime: new Date(),
        mtimeMs: Date.now(),
        mtime: new Date(),
      };
    }),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('fs/promises', () => ({
  appendFile: vi.fn(async (path: string, content: string) => {
    const key = normalizePath(path);
    const files = (globalThis as any)._fsFiles || {};
    files[key] = (files[key] || '') + content;
  }),
  writeFile: vi.fn(async (path: string, content: string) => {
    const key = normalizePath(path);
    const files = (globalThis as any)._fsFiles || {};
    files[key] = content;
  }),
  stat: vi.fn(async (path: string) => {
    const key = normalizePath(path);
    const files = (globalThis as any)._fsFiles || {};
    const content = files[key];
    if (content === undefined) {
      throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    }
    return {
      size: content.length,
      birthtimeMs: Date.now(),
      birthtime: new Date(),
      mtimeMs: Date.now(),
      mtime: new Date(),
    };
  }),
  rename: vi.fn(async (oldPath: string, newPath: string) => {
    const oldKey = normalizePath(oldPath);
    const newKey = normalizePath(newPath);
    const files = (globalThis as any)._fsFiles || {};
    if (files[oldKey] !== undefined) {
      files[newKey] = files[oldKey];
      delete files[oldKey];
    }
  }),
  mkdir: vi.fn(async () => {}),
}));

// ─── Mock pattern-normalizer ───────────────────────────────────────────────────
vi.mock('@/lib/services/pattern-normalizer', () => ({
  sanitizeDescriptionForAdaptive: vi.fn((desc: string, _config: any) => {
    return desc.toLowerCase().replace(/^(zelle\s+)?(payment|transfer)\s+(to|from)\s+/gi, '').trim();
  }),
}));

// ─── Tests ─────────────────────────────────────────────────────────────────────
describe('Adaptive Engine — recordFeedback', () => {
  let recordFeedback: typeof import('../../src/lib/learning/adaptive-engine')['recordFeedback'];
  let computeDescriptionHash: typeof import('../../src/lib/learning/adaptive-engine')['computeDescriptionHash'];

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../../src/lib/learning/adaptive-engine');
    recordFeedback = mod.recordFeedback;
    computeDescriptionHash = mod.computeDescriptionHash;
    (globalThis as any)._fsFiles = {
      'rules/learning-engine.json': defaultEngineConfig,
      '.data/learning-events.jsonl': '',
    };
  });

  // ── Helpers ──────────────────────────────────────────────────────────────────
  const baseEvent = {
    timestamp: new Date().toISOString(),
    bankDescription: 'Zelle to Vendor X',
    selectedGlAccountCode: '1010',
    confidence: 0.9,
    userId: 'u1',
    companyId: 'company-123',
  };

  // ── Tests ────────────────────────────────────────────────────────────────────

  it('should record a feedback event to the log file', async () => {
    await recordFeedback(baseEvent);

    const files = (globalThis as any)._fsFiles;
    const logContent = files['.data/learning-events.jsonl'];
    expect(logContent).toBeTruthy();
    expect(logContent.trim()).toBe(JSON.stringify(baseEvent));
  });

  it('should append multiple events as separate JSON lines', async () => {
    const eventA = { ...baseEvent, selectedGlAccountCode: '1010' };
    const eventB = { ...baseEvent, selectedGlAccountCode: '2020', bankDescription: 'Wire transfer to Supplier Y' };

    await recordFeedback(eventA);
    await recordFeedback(eventB);

    const files = (globalThis as any)._fsFiles;
    const lines = files['.data/learning-events.jsonl'].trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ selectedGlAccountCode: '1010' });
    expect(JSON.parse(lines[1])).toMatchObject({ selectedGlAccountCode: '2020' });
  });

  it('should include optional amount field when provided', async () => {
    const eventWithAmount = { ...baseEvent, amount: 1500.5 };
    await recordFeedback(eventWithAmount);

    const files = (globalThis as any)._fsFiles;
    const parsed = JSON.parse(files['.data/learning-events.jsonl'].trim());
    expect(parsed.amount).toBe(1500.5);
  });

  it('should handle events without amount (amount undefined)', async () => {
    await recordFeedback(baseEvent);

    const files = (globalThis as any)._fsFiles;
    const parsed = JSON.parse(files['.data/learning-events.jsonl'].trim());
    expect(parsed).not.toHaveProperty('amount');
  });

  it('should handle events with very low confidence (0)', async () => {
    const lowConfEvent = { ...baseEvent, confidence: 0 };
    await recordFeedback(lowConfEvent);

    const files = (globalThis as any)._fsFiles;
    const parsed = JSON.parse(files['.data/learning-events.jsonl'].trim());
    expect(parsed.confidence).toBe(0);
  });

  it('should handle events with very high confidence (1)', async () => {
    const highConfEvent = { ...baseEvent, confidence: 1 };
    await recordFeedback(highConfEvent);

    const files = (globalThis as any)._fsFiles;
    const parsed = JSON.parse(files['.data/learning-events.jsonl'].trim());
    expect(parsed.confidence).toBe(1);
  });

  it('should handle events with negative amounts (debits)', async () => {
    const debitEvent = { ...baseEvent, amount: -250.0 };
    await recordFeedback(debitEvent);

    const files = (globalThis as any)._fsFiles;
    const parsed = JSON.parse(files['.data/learning-events.jsonl'].trim());
    expect(parsed.amount).toBe(-250.0);
  });

  it('should handle events with large amounts', async () => {
    const largeAmtEvent = { ...baseEvent, amount: 9999999.99 };
    await recordFeedback(largeAmtEvent);

    const files = (globalThis as any)._fsFiles;
    const parsed = JSON.parse(files['.data/learning-events.jsonl'].trim());
    expect(parsed.amount).toBe(9999999.99);
  });

  // ── Dedup Tests ─────────────────────────────────────────────────────────────────

  it('should skip recording when the same description hash already exists (dedup)', async () => {
    await recordFeedback(baseEvent);

    // Same bankDescription → should be skipped
    const duplicateEvent = {
      ...baseEvent,
      timestamp: new Date(Date.now() + 1000).toISOString(), // different time
      confidence: 0.95, // different confidence
    };
    await recordFeedback(duplicateEvent);

    const files = (globalThis as any)._fsFiles;
    const lines = files['.data/learning-events.jsonl'].trim().split('\n');
    expect(lines).toHaveLength(1); // only first event recorded
    const parsed = JSON.parse(lines[0]);
    expect(parsed.confidence).toBe(0.9); // original event kept
  });

  it('should record events with different descriptions (different hashes)', async () => {
    await recordFeedback(baseEvent);

    const differentEvent = {
      ...baseEvent,
      bankDescription: 'Wire Transfer to Supplier ABC',
      selectedGlAccountCode: '2020',
    };
    await recordFeedback(differentEvent);

    const files = (globalThis as any)._fsFiles;
    const lines = files['.data/learning-events.jsonl'].trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ bankDescription: 'Zelle to Vendor X' });
    expect(JSON.parse(lines[1])).toMatchObject({ bankDescription: 'Wire Transfer to Supplier ABC' });
  });

  it('should treat descriptions with different casing as duplicates', async () => {
    await recordFeedback(baseEvent);

    const sameButDifferentCase = {
      ...baseEvent,
      bankDescription: 'zelle to vendor x', // lowercase version
    };
    await recordFeedback(sameButDifferentCase);

    const files = (globalThis as any)._fsFiles;
    const lines = files['.data/learning-events.jsonl'].trim().split('\n');
    expect(lines).toHaveLength(1); // same hash (lowercased before hashing)
  });

  it('should treat descriptions with extra whitespace as duplicates', async () => {
    await recordFeedback(baseEvent);

    const paddedEvent = {
      ...baseEvent,
      bankDescription: '  Zelle to Vendor X  ', // padded
    };
    await recordFeedback(paddedEvent);

    const files = (globalThis as any)._fsFiles;
    const lines = files['.data/learning-events.jsonl'].trim().split('\n');
    expect(lines).toHaveLength(1); // same hash (trimmed before hashing)
  });

  // ── Multiple events, mixed dedup ────────────────────────────────────────────────

  it('should handle interleaved duplicates and unique events', async () => {
    const event1 = { ...baseEvent };
    const event2 = { ...baseEvent, bankDescription: 'Zelle to Vendor X' }; // duplicate of event1
    const event3 = { ...baseEvent, bankDescription: 'ACH Payment from Client' };

    await recordFeedback(event1);
    await recordFeedback(event2); // should be skipped (dedup)
    await recordFeedback(event3); // unique

    const files = (globalThis as any)._fsFiles;
    const lines = files['.data/learning-events.jsonl'].trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ bankDescription: 'Zelle to Vendor X' });
    expect(JSON.parse(lines[1])).toMatchObject({ bankDescription: 'ACH Payment from Client' });
  });

  // ── computeDescriptionHash unit test ────────────────────────────────────────────

  it('computeDescriptionHash should produce deterministic output', () => {
    const hash1 = computeDescriptionHash('Zelle to Vendor X');
    const hash2 = computeDescriptionHash('zelle to vendor x');
    const hash3 = computeDescriptionHash('  Zelle to Vendor X  ');

    expect(hash1).toBe(hash2);
    expect(hash1).toBe(hash3);
    expect(hash1).toHaveLength(64); // sha256 hex length
  });

  it('computeDescriptionHash should produce different hashes for different descriptions', () => {
    const hash1 = computeDescriptionHash('Payment to Vendor A');
    const hash2 = computeDescriptionHash('Payment to Vendor B');
    expect(hash1).not.toBe(hash2);
  });
});
