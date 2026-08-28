import type { EngineDecision, DecisionResult } from './types';
import { parseWithAI } from '@/lib/services/conversational-service';
import { resolveGLAccount } from '@/lib/services/conversational-service';
import { getAiConfig } from '@/lib/ai-config';
import { logger } from '@/lib/logger';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AiFallbackInput {
  companyId: string;
  transactionId: string;
  description: string;
  amount: number;
  decision: EngineDecision;
}

export interface AiFallbackProposal {
  role: string;
  glAccountCode: string;
  glAccountId: string | null;
  conditions?: { field: string; operator: string; value: string | number }[];
  suggestSubAccount: boolean;
  subAccountName: string | null;
}

export interface AiBridgeDeps {
  parseWithAI?: typeof parseWithAI;
  resolveGLAccount?: typeof resolveGLAccount;
  getAiConfig?: typeof getAiConfig;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const TRIGGER_RESULTS: Set<DecisionResult> = new Set(['no_match', 'ambiguous']);

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * AI fallback bridge — receives a deterministic engine decision and, only when
 * the result is NO_MATCH or AMBIGUOUS, calls the AI model to produce a
 * classification proposal.
 *
 * The proposal is a standalone object: it never mutates the EngineDecision,
 * never auto-classifies a BankTransaction, and never creates GL accounts.
 *
 * Returns `null` when:
 *  - decision.result is not NO_MATCH/AMBIGUOUS
 *  - AI is not configured
 *  - AI call fails
 */
export async function aiFallback(
  input: AiFallbackInput,
  deps: AiBridgeDeps = {},
): Promise<AiFallbackProposal | null> {
  const { decision, companyId, transactionId, description, amount } = input;

  // 1. Only trigger for NO_MATCH or AMBIGUOUS
  if (!TRIGGER_RESULTS.has(decision.result)) {
    return null;
  }

  // 2. Resolve dependencies
  const parseFn = deps.parseWithAI ?? parseWithAI;
  const resolveFn = deps.resolveGLAccount ?? resolveGLAccount;
  const configFn = deps.getAiConfig ?? getAiConfig;

  // 3. Get AI config — if not configured, fail gracefully
  let aiConfig;
  try {
    aiConfig = await configFn();
  } catch (err) {
    logger.warn('[AI BRIDGE] AI not configured, skipping fallback', {
      transactionId,
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // 4. Call parseWithAI — if it fails, fail gracefully
  let aiResult;
  try {
    aiResult = await parseFn(description, description, {
      apiKey: aiConfig.apiKey,
      baseUrl: aiConfig.baseUrl,
      model: aiConfig.model,
    });
  } catch (err) {
    logger.warn('[AI BRIDGE] AI call failed, skipping fallback', {
      transactionId,
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  // 5. Resolve glAccountId via read-only lookup
  let glAccountId: string | null = null;
  if (aiResult.glAccountCode) {
    try {
      const resolved = await resolveFn(companyId, aiResult.glAccountCode);
      glAccountId = resolved.glAccountId;
    } catch (err) {
      // glAccountId stays null — no creation, no mutation
      logger.warn('[AI BRIDGE] GL account resolution failed', {
        transactionId,
        companyId,
        glAccountCode: aiResult.glAccountCode,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 6. Return proposal — never mutates decision
  return {
    role: aiResult.role,
    glAccountCode: aiResult.glAccountCode,
    glAccountId,
    conditions: aiResult.conditions,
    suggestSubAccount: aiResult.suggestSubAccount,
    subAccountName: aiResult.subAccountName,
  };
}
