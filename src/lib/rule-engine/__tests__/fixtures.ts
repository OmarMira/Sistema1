import type { BankRule, Transaction, RuleCondition, RuleInput, EvaluatedCondition, RuleConditionType, Candidate, RuleLifecycleStatus } from '../types';

let ruleIdCounter = 0;
let txIdCounter = 0;

export function makeRule(overrides?: Partial<BankRule>): BankRule {
  ruleIdCounter++;
  return {
    id: `rule-${ruleIdCounter}`,
    companyId: 'company-1',
    priority: 10,
    conditions: [],
    action: {},
    isActive: true,
    lifecycleStatus: 'active' as RuleLifecycleStatus,
    ...overrides,
  };
}

export function makeTransaction(overrides?: Partial<Transaction>): Transaction {
  txIdCounter++;
  const now = new Date();
  return {
    id: `tx-${txIdCounter}`,
    date: now,
    description: 'Test transaction',
    amount: 1000,
    bankAccountId: 'acc-1',
    companyId: 'company-1',
    ...overrides,
  };
}

export function makeCondition(type: RuleConditionType, value: string | number, range?: [number, number]): RuleCondition {
  const c: RuleCondition = { type, value };
  if (range !== undefined) c.range = range;
  return c;
}

export function makeRuleInput(overrides?: Partial<RuleInput>): RuleInput {
  return {
    transaction: makeTransaction(),
    context: { availableRules: [], entityContexts: [], historicalMatches: [] },
    ...overrides,
  };
}

export function makeEvaluatedCondition(overrides?: Partial<EvaluatedCondition>): EvaluatedCondition {
  return {
    type: 'amount_gt' as RuleConditionType,
    score: 1,
    match: true,
    detail: '',
    ...overrides,
  };
}

export const presets = {
  get oneActiveRule() { return makeRule(); },
  get threeActiveRules() { return [makeRule(), makeRule(), makeRule()]; },
  get mixedLifecycleRules() {
    return [
      makeRule({ lifecycleStatus: 'active' as RuleLifecycleStatus }),
      makeRule({ lifecycleStatus: 'draft' as RuleLifecycleStatus }),
      makeRule({ lifecycleStatus: 'testing' as RuleLifecycleStatus }),
      makeRule({ lifecycleStatus: 'archived' as RuleLifecycleStatus }),
      makeRule({ lifecycleStatus: 'deprecated' as RuleLifecycleStatus }),
    ];
  },
  get validTransaction() { return makeTransaction(); },
  get validRuleInput() { return makeRuleInput(); },
  get emptyRuleInput() { return makeRuleInput({ context: { availableRules: [], entityContexts: [], historicalMatches: [] } }); },
  get invoiceScenarioRule() {
    return makeRule({
      conditions: [
        makeCondition('amount_gt', 500),
        makeCondition('description_contains', 'INVOICE'),
      ],
    });
  },
};
