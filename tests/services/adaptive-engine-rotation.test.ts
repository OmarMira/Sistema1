import { describe, it, expect, vi, beforeEach } from 'vitest';

// Initialize global files database
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
  // Strip trailing slash if present (except if it's just the root)
  if (clean.length > 1 && clean.endsWith('/')) {
    clean = clean.slice(0, -1);
  }
  const index = clean.indexOf('rules');
  if (index !== -1) {
    return clean.slice(index);
  }
  return clean;
};

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

      let birthtimeMs = Date.now();
      if (key.includes('archive-old')) {
        birthtimeMs = Date.now() - 40 * 24 * 60 * 60 * 1000;
      }

      return {
        size: content.length,
        birthtimeMs,
        birthtime: new Date(birthtimeMs),
        mtimeMs: birthtimeMs,
        mtime: new Date(birthtimeMs),
      };
    }),
    readdirSync: vi.fn((dir: string) => {
      const files = (globalThis as any)._fsFiles || {};
      return Object.keys(files)
        .map((k) => k.split('/').pop() || '')
        .filter((name) => name.startsWith('learning-events'));
    }),
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
    let birthtimeMs = Date.now();
    if (key.includes('archive-old')) {
      birthtimeMs = Date.now() - 40 * 24 * 60 * 60 * 1000;
    }
    return {
      size: content.length,
      birthtimeMs,
      birthtime: new Date(birthtimeMs),
      mtimeMs: birthtimeMs,
      mtime: new Date(birthtimeMs),
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

// Import the service after mocking fs
import { recordFeedback, generateCandidateRules } from '../../src/lib/learning/adaptive-engine';

describe('Adaptive Engine Rotation and Memory Retrieval', () => {
  beforeEach(() => {
    (globalThis as any)._fsFiles = {
      'rules/learning-engine.json': defaultEngineConfig,
    };
  });

  const getFiles = () => (globalThis as any)._fsFiles;
  const writeFileSyncDirect = (key: string, content: string) => {
    (globalThis as any)._fsFiles[key] = content;
  };

  it('should append log without rotation if file size is under 5MB', async () => {
    // Write 1KB of content first
    writeFileSyncDirect('rules/learning-events.jsonl', 'a'.repeat(1024));

    const event = {
      timestamp: new Date().toISOString(),
      bankDescription: 'Zelle to Vendor X',
      selectedGlAccountCode: '1010',
      confidence: 0.9,
      userId: 'u1',
      companyId: 'company-123',
    };

    await recordFeedback(event);

    const files = getFiles();
    // Active log should have the original content + new event
    const activeContent = files['rules/learning-events.jsonl'];
    expect(activeContent).toContain('1010');
    expect(activeContent.length).toBeGreaterThan(1024);

    // No archive file should have been created
    const hasArchive = Object.keys(files).some((k) => k.includes('archive'));
    expect(hasArchive).toBe(false);
  });

  it('should rotate active log to archive and start fresh log if file size exceeds 5MB', async () => {
    // Write 5.1MB of content to simulate large file
    const largeContent = 'b'.repeat(5.1 * 1024 * 1024);
    writeFileSyncDirect('rules/learning-events.jsonl', largeContent);

    const event = {
      timestamp: new Date().toISOString(),
      bankDescription: 'Zelle to Vendor Y',
      selectedGlAccountCode: '2020',
      confidence: 0.95,
      userId: 'u1',
      companyId: 'company-123',
    };

    await recordFeedback(event);

    const files = getFiles();
    // The large file should have been renamed/archived
    const archiveKey = Object.keys(files).find((k) => k.includes('learning-events-archive-'));
    expect(archiveKey).toBeDefined();
    expect(files[archiveKey!]).toBe(largeContent);

    // The active log should be fresh and only contain the new event
    const activeContent = files['rules/learning-events.jsonl'];
    expect(activeContent.trim()).toBe(JSON.stringify(event));
  });

  it('should generate candidate rules scanning active log and recent archives, ignoring archives older than 30 days', () => {
    // Setup active log with some events
    const activeEvent = {
      timestamp: new Date().toISOString(),
      bankDescription: 'Zelle to Shop A',
      selectedGlAccountCode: '1200',
      confidence: 0.95,
      userId: 'u1',
      companyId: 'company-123',
    };
    writeFileSyncDirect('rules/learning-events.jsonl', JSON.stringify(activeEvent) + '\n');

    // Setup recent archive (within 30 days) containing 2 occurrences
    const recentEvent = {
      timestamp: new Date().toISOString(),
      bankDescription: 'Zelle to Shop A',
      selectedGlAccountCode: '1200',
      confidence: 0.95,
      userId: 'u1',
      companyId: 'company-123',
    };
    writeFileSyncDirect(
      'rules/learning-events-archive-recent.jsonl',
      JSON.stringify(recentEvent) + '\n' + JSON.stringify(recentEvent) + '\n'
    );

    // Setup old archive (older than 30 days) containing 5 occurrences
    // Note: our mock fs returns old dates for paths containing 'archive-old'
    const oldEvent = {
      timestamp: new Date().toISOString(),
      bankDescription: 'Zelle to Shop A',
      selectedGlAccountCode: '1200',
      confidence: 0.95,
      userId: 'u1',
      companyId: 'company-123',
    };
    writeFileSyncDirect(
      'rules/learning-events-archive-old.jsonl',
      JSON.stringify(oldEvent) + '\n' + JSON.stringify(oldEvent) + '\n'
    );

    // Generate candidates. Config minOccurrencesToGenerateRule is 3.
    // Active (1) + Recent (2) = 3 -> should generate rule!
    // Old (2) should be ignored. If old was not ignored, we would get total of 5.
    const candidates = generateCandidateRules('company-123');

    console.log('Generated Candidates:', JSON.stringify(candidates, null, 2));

    expect(candidates).toHaveLength(1);
    expect(candidates[0].glAccountCode).toBe('1200');
    expect(candidates[0].occurrences).toBe(3); // Active (1) + Recent (2)
  });
});
