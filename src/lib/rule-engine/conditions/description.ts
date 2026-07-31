import type { RuleCondition, Transaction, EvaluatedCondition } from '../types';
import { InvalidRegex } from '../errors';
import { normalizeText } from './normalize';

export function evaluateDescriptionEq(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const desc = normalizeText(transaction.description ?? '');
  const value = normalizeText(condition.value);
  if (value.length === 0) {
    return { type: condition.type, score: 0, match: false, detail: `desc "${desc}" === "${value}": false` };
  }
  const match = desc === value;
  return { type: condition.type, score: match ? 1 : 0, match, detail: `desc "${desc}" === "${value}": ${match}` };
}

export function evaluateDescriptionContains(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const desc = normalizeText(transaction.description ?? '');
  const value = normalizeText(condition.value);
  if (value.length === 0) {
    return { type: condition.type, score: 0, match: false, detail: `desc contains "${value}": false` };
  }
  if (desc.length === 0 || value.length > desc.length) {
    return { type: condition.type, score: 0, match: false, detail: `desc contains "${value}": false` };
  }
  const score = desc.includes(value) ? value.length / desc.length : 0;
  const match = score > 0;
  return { type: condition.type, score, match, detail: `desc contains "${value}": ${match}` };
}

export function evaluateDescriptionStartsWith(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const desc = normalizeText(transaction.description ?? '');
  const value = normalizeText(condition.value);
  if (value.length === 0) {
    return { type: condition.type, score: 0, match: false, detail: `desc starts with "${value}": false` };
  }
  const match = desc.startsWith(value);
  return { type: condition.type, score: match ? 1 : 0, match, detail: `desc starts with "${value}": ${match}` };
}

export function evaluateDescriptionEndsWith(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const desc = normalizeText(transaction.description ?? '');
  const value = normalizeText(condition.value);
  if (value.length === 0) {
    return { type: condition.type, score: 0, match: false, detail: `desc ends with "${value}": false` };
  }
  const match = desc.endsWith(value);
  return { type: condition.type, score: match ? 1 : 0, match, detail: `desc ends with "${value}": ${match}` };
}

export function evaluateDescriptionMatches(condition: RuleCondition, transaction: Transaction): EvaluatedCondition {
  const desc = transaction.description ?? '';
  const value = String(condition.value);
  try {
    const regex = new RegExp(value);
    const match = regex.test(desc);
    return { type: condition.type, score: match ? 1 : 0, match, detail: `desc matches /${value}/: ${match}` };
  } catch (e) {
    throw new InvalidRegex(condition.type, { pattern: value, error: String(e) });
  }
}

export const descriptionEvaluators = {
  description_eq: evaluateDescriptionEq,
  description_contains: evaluateDescriptionContains,
  description_starts_with: evaluateDescriptionStartsWith,
  description_ends_with: evaluateDescriptionEndsWith,
  description_matches: evaluateDescriptionMatches,
} as const;
