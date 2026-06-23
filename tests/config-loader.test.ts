import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockReadFile, mockAccess } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockAccess: vi.fn(),
}));

vi.mock('fs/promises', () => ({
  readFile: mockReadFile,
  access: mockAccess,
}));

// Import after mocks are set up
import { readJsonConfig, fileExists, clearConfigCache } from '@/lib/config-loader';

describe('readJsonConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearConfigCache();
  });

  it('reads and parses a JSON file', async () => {
    mockReadFile.mockResolvedValue('{"name": "test", "value": 42}');

    const result = await readJsonConfig('test.json');
    expect(result).toEqual({ name: 'test', value: 42 });
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('caches the result and avoids re-reading the file', async () => {
    mockReadFile.mockResolvedValue('{"key": "value"}');

    const result1 = await readJsonConfig('test.json');
    expect(result1).toEqual({ key: 'value' });
    expect(mockReadFile).toHaveBeenCalledTimes(1);

    const result2 = await readJsonConfig('test.json');
    expect(result2).toEqual({ key: 'value' });
    // Should NOT have called readFile again — cached
    expect(mockReadFile).toHaveBeenCalledTimes(1);
  });

  it('re-reads file after cache is cleared', async () => {
    mockReadFile
      .mockResolvedValueOnce('{"version": 1}')
      .mockResolvedValueOnce('{"version": 2}');

    const result1 = await readJsonConfig('config.json');
    expect(result1).toEqual({ version: 1 });
    expect(mockReadFile).toHaveBeenCalledTimes(1);

    clearConfigCache();

    const result2 = await readJsonConfig('config.json');
    expect(result2).toEqual({ version: 2 });
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it('handles different filenames independently', async () => {
    mockReadFile
      .mockResolvedValueOnce('{"file": "a"}')
      .mockResolvedValueOnce('{"file": "b"}');

    const [a, b] = await Promise.all([
      readJsonConfig('a.json'),
      readJsonConfig('b.json'),
    ]);

    expect(a).toEqual({ file: 'a' });
    expect(b).toEqual({ file: 'b' });
    expect(mockReadFile).toHaveBeenCalledTimes(2);
  });

  it('throws on invalid JSON', async () => {
    mockReadFile.mockResolvedValue('not valid json');

    await expect(readJsonConfig('bad.json')).rejects.toThrow();
  });
});

describe('fileExists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns true when access resolves', async () => {
    mockAccess.mockResolvedValue(undefined);
    const result = await fileExists('/some/path');
    expect(result).toBe(true);
    expect(mockAccess).toHaveBeenCalledWith('/some/path');
  });

  it('returns false when access rejects', async () => {
    mockAccess.mockRejectedValue(new Error('ENOENT'));
    const result = await fileExists('/missing/path');
    expect(result).toBe(false);
    expect(mockAccess).toHaveBeenCalledWith('/missing/path');
  });
});

describe('clearConfigCache', () => {
  it('does not throw when called', () => {
    expect(() => clearConfigCache()).not.toThrow();
  });
});
