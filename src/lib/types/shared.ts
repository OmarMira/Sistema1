import { Prisma } from '@prisma/client';

// ─── Bank Rule Condition (stored as Json in BankRule.conditions) ─────
export interface RuleCondition {
  field: 'description' | 'amount';
  operator:
    | 'contains'
    | 'starts_with'
    | 'ends_with'
    | 'equals'
    | 'amount_greater'
    | 'amount_less'
    | 'greater_than'
    | 'greaterThan'
    | 'less_than'
    | 'lessThan';
  value: string | number;
}

// ─── Bank Rule with conditions properly typed ────────────────────────
export interface BankRuleWithConditions {
  id: string;
  companyId: string;
  name: string;
  conditionType: string;
  conditionValue: string;
  transactionDirection: string;
  glAccountId: string | null;
  conditions: RuleCondition[] | null;
  debitGlAccountId: string | null;
  creditGlAccountId: string | null;
  priority: number;
  isActive: boolean;
  glAccount?: { id: string; name: string; code: string } | null;
  debitGlAccount?: { id: string } | null;
  creditGlAccount?: { id: string } | null;
}

// ─── Parsed transaction from CSV/PDF/OFX import ──────────────────────
export interface ParsedTransaction {
  date: Date;
  description: string;
  amount: number;
  reference?: string;
}

// ─── Balance info for statement import ───────────────────────────────
export interface StatementBalanceInfo {
  startDate: Date;
  endDate: Date;
  openingBalance: number;
  closingBalance: number;
}

// ─── Assistant config (rules/assistant-config.json) ──────────────────
export interface AssistantConfig {
  systemInstruction?: string;
  temperature?: number;
  maxTokens?: number;
  heuristics?: {
    priorities?: string[];
    fallback?: { role: string; glAccountCode: string };
    rules?: HeuristicRule[];
  };
}

export interface HeuristicRule {
  role: string;
  glAccountCode: string;
  debitGlAccountCode?: string;
  creditGlAccountCode?: string;
  keywords: { es: string[]; en: string[] };
}

// ─── AI Assistant types ──────────────────────────────────────────────
export interface AiChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
  name?: string;
  tool_calls?: AiToolCall[];
}

export interface AiToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AiChoice {
  message: {
    role?: string;
    content?: string | null;
    tool_calls?: AiToolCall[];
  };
}

export interface AiResponse {
  choices?: AiChoice[];
}

export interface ParsedRuleFromAI {
  name?: string;
  conditions?: RuleCondition[];
  debitGlAccountName?: string | null;
  creditGlAccountName?: string | null;
  glAccountName?: string | null;
  transactionDirection?: string;
  priority?: number;
  confidence?: number;
  confidenceLabel?: string;
}

// ─── Dynamic Prisma where input types ────────────────────────────────
export type BankTransactionWhereInput = Prisma.BankTransactionWhereInput;

// ─── Dashboard KPI / export types ────────────────────────────────────
export interface DashboardKPI {
  assets: number;
  liabilities: number;
  equity: number;
  revenue: number;
  expenses: number;
}

export interface DashboardAlert {
  type: string;
  message: string;
  severity?: string;
}

export interface DashboardTrendPoint {
  month: string;
  revenue: number;
  expenses: number;
  net: number;
}
