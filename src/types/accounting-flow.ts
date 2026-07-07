export interface FlowSummary {
  periodStart: string;
  periodEnd: string;
  totalInflows: number;
  totalOutflows: number;
  netFlow: number;
  transactionCount: number;
}

export interface FlowByPeriod {
  period: string; // YYYY-MM
  inflows: number;
  outflows: number;
  net: number;
}

export interface FlowByAccount {
  code: string;
  name: string;
  type: string;
  debit: number;
  credit: number;
  net: number;
}

export interface FlowTransaction {
  id: string;
  date: string; // YYYY-MM-DD
  description: string;
  account: string; // Nombre de la cuenta de contrapartida
  accountCode: string; // Código de la cuenta de contrapartida
  amount: number; // Positivo para inflow, negativo para outflow
  type: 'inflow' | 'outflow';
  source: 'journal' | 'bank_transaction';
}

export interface AccountingFlowResponse {
  summary: FlowSummary;
  byPeriod: FlowByPeriod[];
  byAccount: FlowByAccount[];
  transactions: FlowTransaction[];
}
