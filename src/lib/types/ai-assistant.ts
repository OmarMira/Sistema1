/* ─── Types ───────────────────────────────────────────────────────── */

export type AssistantMode = 'chat' | 'create-rule';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ConditionV2 {
  field: 'description' | 'amount';
  operator: 'contains' | 'starts_with' | 'ends_with' | 'equals' | 'amount_greater' | 'amount_less';
  value: string | number;
}

export interface ParsedRule {
  name: string;
  conditions: ConditionV2[];
  transactionDirection: string;
  glAccountName?: string | null;
  debitGlAccountName?: string | null;
  creditGlAccountName?: string | null;
  priority: number;
  // Legacy V1 fields (kept for backwards compat)
  conditionType?: string;
  conditionValue?: string;
  // Confidence/reasoning fields (from PR 2)
  confidence?: number;
  confidenceLabel?: 'high' | 'medium' | 'low';
  explanation?: string;
  uncertaintyReasons?: string[];
}

export interface HistoryEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/* ─── Animation Variants ──────────────────────────────────────────── */

export const overlayVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
} as const;

export const modalVariants = {
  hidden: { opacity: 0, scale: 0.92, y: 20 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 300, damping: 30 },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: 10,
    transition: { duration: 0.15 },
  },
} as const;

export const messageVariants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.2 } },
} as const;
