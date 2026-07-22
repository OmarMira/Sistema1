const V2_FLAG_KEY = 'RULE_ENGINE_V2_ENABLED';
const ADAPTER_FLAG_KEY = 'RULE_ENGINE_ADAPTER_ENABLED';
const POLICY_OBSERVATION_KEY = 'OPERATIONAL_POLICY_OBSERVATION_ENABLED';
const IMPORT_POLICY_OBSERVATION_KEY = 'OPERATIONAL_POLICY_IMPORT_OBSERVATION_ENABLED';

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
