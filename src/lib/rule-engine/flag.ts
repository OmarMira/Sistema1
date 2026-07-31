const V2_FLAG_KEY = 'RULE_ENGINE_V2_ENABLED';
const ADAPTER_FLAG_KEY = 'RULE_ENGINE_ADAPTER_ENABLED';
const ENGINE_MODE_KEY = 'BANK_RULE_ENGINE';
const POLICY_OBSERVATION_KEY = 'OPERATIONAL_POLICY_OBSERVATION_ENABLED';
const IMPORT_POLICY_OBSERVATION_KEY = 'OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED';

export type EngineMode = 'legacy' | 'precedence' | 'v2';

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

export function getEngineMode(): EngineMode {
  if (typeof process === 'undefined') return 'legacy';
  const raw = process.env[ENGINE_MODE_KEY];
  if (raw === 'legacy') return 'legacy';
  if (raw === 'precedence') return 'precedence';
  if (raw === 'v2') return 'v2';

  // Missing or invalid BANK_RULE_ENGINE → fall back to flags,
  // preserving the exact precedence order of the legacy resolver:
  // adapter flag first, then V2 flag, else legacy.
  if (isRuleEngineAdapterEnabled()) return 'precedence';
  if (isRuleEngineV2Enabled()) return 'v2';
  return 'legacy';
}

export function isOperationalPolicyObservationEnabled(): boolean {
  if (typeof process === 'undefined') return false;
  const raw = process.env[POLICY_OBSERVATION_KEY];
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw === 'true' || raw === 'yes';
}

export function isOperationalPolicyImportObservationEnabled(): boolean {
  if (typeof process === 'undefined') return false;
  const raw = process.env[IMPORT_POLICY_OBSERVATION_KEY];
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw === 'true' || raw === 'yes';
}
