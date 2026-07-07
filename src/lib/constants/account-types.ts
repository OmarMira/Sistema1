export interface AccountTypeMeta {
  normalBalance: 'debit' | 'credit';
  isPL: boolean;
  order: number;
}

export const ACCOUNT_TYPE_META: Record<string, AccountTypeMeta> = {
  asset: { normalBalance: 'debit', isPL: false, order: 0 },
  liability: { normalBalance: 'credit', isPL: false, order: 1 },
  equity: { normalBalance: 'credit', isPL: false, order: 2 },
  revenue: { normalBalance: 'credit', isPL: true, order: 3 },
  expense: { normalBalance: 'debit', isPL: true, order: 4 },
};

export const ACCOUNT_TYPES = Object.keys(ACCOUNT_TYPE_META);

export const GAAP_TYPE_ORDER = ACCOUNT_TYPES.sort(
  (a, b) => ACCOUNT_TYPE_META[a].order - ACCOUNT_TYPE_META[b].order,
);

export function isValidAccountType(type: string): boolean {
  return type in ACCOUNT_TYPE_META;
}

export function isPLAccount(type: string): boolean {
  return ACCOUNT_TYPE_META[type]?.isPL ?? false;
}
