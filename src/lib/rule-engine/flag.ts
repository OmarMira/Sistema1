const V2_FLAG_KEY = 'RULE_ENGINE_V2_ENABLED';
const ADAPTER_FLAG_KEY = 'RULE_ENGINE_ADAPTER_ENABLED';

export function isRuleEngineV2Enabled(): boolean {
  if (typeof process === 'undefined') return false;
  const raw = process.env[V2_FLAG_KEY];
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function isRuleEngineAdapterEnabled(): boolean {
  if (typeof process === 'undefined') return false;
  const raw = process.env[ADAPTER_FLAG_KEY];
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw === 'true' || raw === 'yes';
}
