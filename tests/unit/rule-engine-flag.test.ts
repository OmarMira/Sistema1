import { describe, it, expect, afterEach } from 'vitest';
import {
  getEngineMode,
  isRuleEngineV2Enabled,
  isRuleEngineAdapterEnabled,
} from '@/lib/rule-engine/flag';

const ENGINE_MODE_KEY = 'BANK_RULE_ENGINE';
const V2_FLAG_KEY = 'RULE_ENGINE_V2_ENABLED';
const ADAPTER_FLAG_KEY = 'RULE_ENGINE_ADAPTER_ENABLED';

function clearEnv() {
  delete process.env[ENGINE_MODE_KEY];
  delete process.env[V2_FLAG_KEY];
  delete process.env[ADAPTER_FLAG_KEY];
}

afterEach(() => {
  clearEnv();
});

describe('getEngineMode — explicit BANK_RULE_ENGINE', () => {
  it('returns legacy when BANK_RULE_ENGINE=legacy even with flags on', () => {
    process.env[ENGINE_MODE_KEY] = 'legacy';
    process.env[V2_FLAG_KEY] = '1';
    process.env[ADAPTER_FLAG_KEY] = '1';
    expect(getEngineMode()).toBe('legacy');
  });

  it('returns precedence when BANK_RULE_ENGINE=precedence even with flags off', () => {
    process.env[ENGINE_MODE_KEY] = 'precedence';
    expect(getEngineMode()).toBe('precedence');
  });

  it('returns v2 when BANK_RULE_ENGINE=v2', () => {
    process.env[ENGINE_MODE_KEY] = 'v2';
    process.env[V2_FLAG_KEY] = '0';
    expect(getEngineMode()).toBe('v2');
  });
});

describe('getEngineMode — fallback when missing', () => {
  it('falls back to precedence when adapter flag on even if v2 flag also on (adapter first)', () => {
    process.env[ADAPTER_FLAG_KEY] = '1';
    process.env[V2_FLAG_KEY] = '1';
    expect(getEngineMode()).toBe('precedence');
  });

  it('falls back to precedence when only adapter flag is on', () => {
    process.env[ADAPTER_FLAG_KEY] = 'true';
    expect(getEngineMode()).toBe('precedence');
  });

  it('falls back to v2 when only v2 flag is on', () => {
    process.env[V2_FLAG_KEY] = 'yes';
    expect(getEngineMode()).toBe('v2');
  });

  it('falls back to legacy when no flags are set', () => {
    expect(getEngineMode()).toBe('legacy');
  });

  it('treats empty BANK_RULE_ENGINE as missing', () => {
    process.env[ENGINE_MODE_KEY] = '';
    process.env[V2_FLAG_KEY] = '1';
    expect(getEngineMode()).toBe('v2');
  });
});

describe('getEngineMode — invalid value falls back', () => {
  it('falls back to adapter order when BANK_RULE_ENGINE is invalid and adapter flag on', () => {
    process.env[ENGINE_MODE_KEY] = 'production';
    process.env[ADAPTER_FLAG_KEY] = '1';
    process.env[V2_FLAG_KEY] = '1';
    expect(getEngineMode()).toBe('precedence');
  });

  it('falls back to v2 when BANK_RULE_ENGINE is invalid and only v2 flag on', () => {
    process.env[ENGINE_MODE_KEY] = 'banana';
    process.env[V2_FLAG_KEY] = '1';
    expect(getEngineMode()).toBe('v2');
  });

  it('falls back to legacy when BANK_RULE_ENGINE is invalid and no flags', () => {
    process.env[ENGINE_MODE_KEY] = '9';
    expect(getEngineMode()).toBe('legacy');
  });
});

describe('flag helpers', () => {
  it('isRuleEngineV2Enabled accepts 1/true/yes', () => {
    for (const val of ['1', 'true', 'yes']) {
      process.env[V2_FLAG_KEY] = val;
      expect(isRuleEngineV2Enabled()).toBe(true);
      clearEnv();
    }
  });

  it('isRuleEngineV2Enabled is false for unset, empty, or invalid values', () => {
    expect(isRuleEngineV2Enabled()).toBe(false);
    process.env[V2_FLAG_KEY] = '';
    expect(isRuleEngineV2Enabled()).toBe(false);
    process.env[V2_FLAG_KEY] = '2';
    expect(isRuleEngineV2Enabled()).toBe(false);
    clearEnv();
  });

  it('isRuleEngineAdapterEnabled accepts 1/true/yes', () => {
    for (const val of ['1', 'true', 'yes']) {
      process.env[ADAPTER_FLAG_KEY] = val;
      expect(isRuleEngineAdapterEnabled()).toBe(true);
      clearEnv();
    }
  });

  it('isRuleEngineAdapterEnabled is false for unset, empty, or invalid values', () => {
    expect(isRuleEngineAdapterEnabled()).toBe(false);
    process.env[ADAPTER_FLAG_KEY] = '';
    expect(isRuleEngineAdapterEnabled()).toBe(false);
    process.env[ADAPTER_FLAG_KEY] = 'maybe';
    expect(isRuleEngineAdapterEnabled()).toBe(false);
    clearEnv();
  });
});
