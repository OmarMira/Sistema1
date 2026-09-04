import { describe, it, expect } from 'vitest';
import { validateEnv } from '@/lib/env/server';

function buildEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: Record<string, string | undefined> = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
    SESSION_SECRET: 'test-secret',
    HMAC_SECRET: 'test-hmac-secret',
  };
  return { ...base, ...overrides };
}

describe('validateEnv server startup policy', () => {
  it('production without DATABASE_URL fails', () => {
    expect(() =>
      validateEnv(buildEnv({ NODE_ENV: 'production', DATABASE_URL: undefined })),
    ).toThrow(/DATABASE_URL/);
  });

  it('production without SESSION_SECRET fails', () => {
    expect(() =>
      validateEnv(buildEnv({ NODE_ENV: 'production', SESSION_SECRET: undefined })),
    ).toThrow(/SESSION_SECRET/);
  });

  it('production with valid env passes', () => {
    expect(() => validateEnv(buildEnv({ NODE_ENV: 'production' }))).not.toThrow();
  });

  it('development without SESSION_SECRET passes', () => {
    expect(() =>
      validateEnv(buildEnv({ NODE_ENV: 'development', SESSION_SECRET: undefined })),
    ).not.toThrow();
  });

  it('development without DATABASE_URL fails', () => {
    expect(() =>
      validateEnv(buildEnv({ NODE_ENV: 'development', DATABASE_URL: undefined })),
    ).toThrow(/DATABASE_URL/);
  });

  it('test mode imposes no requirements from validateEnv', () => {
    expect(() =>
      validateEnv(buildEnv({ NODE_ENV: 'test', DATABASE_URL: undefined, SESSION_SECRET: undefined })),
    ).not.toThrow();
  });

  it('production without HMAC_SECRET fails', () => {
    expect(() =>
      validateEnv(buildEnv({ NODE_ENV: 'production', HMAC_SECRET: undefined })),
    ).toThrow(/HMAC_SECRET/);
  });

  it('defaults to development mode when NODE_ENV is unset', () => {
    expect(() =>
      validateEnv(buildEnv({ NODE_ENV: undefined, SESSION_SECRET: undefined })),
    ).not.toThrow();
  });

  it('error message contains variable name but never its value', () => {
    try {
      validateEnv(buildEnv({ NODE_ENV: 'production', DATABASE_URL: undefined }));
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).not.toContain('postgresql://');
      expect(message).not.toContain('user:pass');
    }
  });

  it('does not mutate process.env', () => {
    const before = process.env.NODE_ENV;
    const originalUrl = process.env.DATABASE_URL;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.DATABASE_URL;
      expect(() => validateEnv()).toThrow(/DATABASE_URL/);
      expect(process.env.DATABASE_URL).toBeUndefined();
    } finally {
      if (before === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = before;
      if (originalUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalUrl;
    }
  });
});