const FLAG_KEY = 'RULE_ENGINE_V2_ENABLED';

export function isRuleEngineV2Enabled(): boolean {
  if (typeof process === 'undefined') return false;
  const raw = process.env[FLAG_KEY];
  if (raw === undefined || raw === '') return false;
  return raw === '1' || raw === 'true' || raw === 'yes';
}
