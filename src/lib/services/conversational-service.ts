import { readFileSync } from 'fs';
import { join } from 'path';
import { db } from '@/lib/db';
import { safeAuditLog } from './audit-service';
import { logger } from '@/lib/logger';
import { checkPromptInjection, addSystemDelimiter } from '@/lib/guardrails';
import { findContext } from '@/lib/services/entity-context-service';
import { ROLE_ACCOUNT_MAP } from '@/lib/constants/role-account-map';
import type { EntityRole } from '@/lib/constants/entity-roles';
import { serverT } from '@/lib/server-i18n';
import type { RuleCondition, AssistantConfig } from '@/lib/types/shared';
import { collectSignals } from './signal-collector';
import { decide } from './decision-engine';

export interface ConversationalParseResult {
  role: string;
  glAccountCode: string;
  glAccountId: string | null;
  suggestSubAccount: boolean;
  subAccountName: string | null;
  account: {
    code: string;
    name: string;
    accountType?: string;
    normalBalance?: string;
  };
  conditions?: RuleCondition[] | null;
  confidence: number;
  confidenceLabel: 'high' | 'medium' | 'low';
  explanation: string;
  uncertaintyReasons: string[];
}

// ── Internal: read assistant config from disk ──
function readAssistantConfigSync(): AssistantConfig {
  try {
    const configPath = join(process.cwd(), 'rules/assistant-config.json');
    return JSON.parse(readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

// ── Layer 1: AI Parser ──
// Pure AI interaction layer: reads config, calls external chat API via fetch,
// returns parsed result or THROWS on failure (no silent fallback).
// Accepts optional deps for DI: fetch and readAssistantConfig.
export async function parseWithAI(
  pattern: string,
  userInput: string,
  deps: {
    apiKey: string;
    baseUrl: string;
    model: string;
    fetch?: typeof globalThis.fetch;
    readAssistantConfig?: () => AssistantConfig;
  },
): Promise<{
  role: string;
  glAccountCode: string;
  conditions?: RuleCondition[];
  suggestSubAccount: boolean;
  subAccountName: string | null;
}> {
  const { apiKey, baseUrl, model } = deps;
  const fetchFn = deps.fetch ?? globalThis.fetch;
  const getConfig = deps.readAssistantConfig ?? readAssistantConfigSync;

  if (!apiKey || !baseUrl || !model) {
    throw new Error('AI configuration missing: AI_API_KEY, AI_BASE_URL, and AI_MODEL must be set');
  }

  // Prompt injection guardrails
  const patternCheck = checkPromptInjection(pattern);
  if (!patternCheck.passed) {
    logger.warn('PROMPT_INJECTION_BLOCKED', { reason: patternCheck.reason, pattern });
    throw new Error('Disallowed content detected in user input.');
  }

  const inputCheck = checkPromptInjection(userInput);
  if (!inputCheck.passed) {
    logger.warn('PROMPT_INJECTION_BLOCKED', { reason: inputCheck.reason, pattern });
    throw new Error('Disallowed content detected in user input.');
  }

  // Build model fallback list (preserving existing openrouter/free behavior)
  const modelsToTry = [model];
  if (model === 'openrouter/free') {
    modelsToTry.push('google/gemini-2.5-flash:free');
    modelsToTry.push('qwen/qwen-2.5-72b-instruct:free');
  }

  const assistantConfig = getConfig();
  const systemInstruction = addSystemDelimiter(assistantConfig.systemInstruction ?? '');

  for (const currentModel of modelsToTry) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout per model

    try {
      const response = await fetchFn(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        },
        body: JSON.stringify({
          model: currentModel,
          temperature: assistantConfig.temperature ?? 0.1,
          max_tokens: assistantConfig.maxTokens ?? 300,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemInstruction },
            {
              role: 'user',
              content: `Entity: "${pattern}"\nUser description: "${userInput}"\nReturn only the JSON object.`,
            },
          ],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`AI API returned status ${response.status}`);
      }

      const resData = await response.json();
      const content = resData.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('AI response missing content');
      }

      const parsed = JSON.parse(content);

      // Validate that we have the minimum required fields
      if (!parsed.role || !parsed.glAccountCode) {
        throw new Error('AI returned incomplete result');
      }

      // Success — return parsed data
      return {
        role: parsed.role,
        glAccountCode: parsed.glAccountCode,
        conditions: parsed.conditions,
        suggestSubAccount: Boolean(parsed.suggestSubAccount),
        subAccountName: parsed.subAccountName ? String(parsed.subAccountName) : null,
      };
    } catch (err: unknown) {
      clearTimeout(timeout);

      // If this was the last model attempt, re-throw so the facade can fallback
      if (currentModel === modelsToTry[modelsToTry.length - 1]) {
        throw err;
      }

      // Otherwise log and try the next model
      logger.warn(`[CONVERSATIONAL PARSE AI FAIL FOR MODEL ${currentModel}]`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new Error('All AI models failed');
}

// ── Layer 2: GL Account Resolver ──
// Pure DB resolution: queries glAccount by companyId + code.
// Returns enriched data or default fallback. Accepts optional deps for DI.
export async function resolveGLAccount(
  companyId: string,
  glAccountCode: string,
  deps?: {
    db?: typeof db;
  },
  locale?: string,
): Promise<{
  glAccountId: string | null;
  account: { code: string; name: string; accountType?: string; normalBalance?: string };
}> {
  const dbClient = deps?.db ?? db;
  const unclassifiedName = serverT(locale, 'accounts.unclassified');

  if (!glAccountCode) {
    return { glAccountId: null, account: { code: '', name: unclassifiedName } };
  }

  try {
    const acc = await dbClient.glAccount.findFirst({
      where: { companyId, code: glAccountCode, isActive: true },
    });

    if (acc) {
      return {
        glAccountId: acc.id,
        account: {
          code: acc.code,
          name: acc.name,
          accountType: acc.accountType,
          normalBalance: acc.normalBalance,
        },
      };
    }

    // Code not in DB — derive accountType from the thousand-range parent
    const num = parseInt(glAccountCode, 10);
    let hintType: string | undefined;
    let hintBalance: string | undefined;
    if (!isNaN(num)) {
      const rangeBase = String(Math.floor(num / 1000) * 1000);
      const parent = await dbClient.glAccount.findFirst({
        where: { companyId, code: rangeBase, isActive: true },
        select: { accountType: true, normalBalance: true },
      });
      hintType = parent?.accountType;
      hintBalance = parent?.normalBalance;
    }
    return {
      glAccountId: null,
      account: {
        code: glAccountCode,
        name: unclassifiedName,
        accountType: hintType,
        normalBalance: hintBalance,
      },
    };
  } catch (dbErr) {
    logger.warn('GL_ACCOUNT_QUERY_FAIL', { companyId, glAccountCode, error: String(dbErr) });
    return { glAccountId: null, account: { code: glAccountCode, name: unclassifiedName } };
  }
}

// ── Facade: parseConversationalContext ──
// Uses the signal-based decision engine to resolve role + GL account.
// 1. Checks EntityContext, tries AI, runs heuristic → collects all signals
// 2. Calls decide() to resolve conflicts
// 3. Resolves GL account from the selected signal
// 4. Returns with confidence, explanation, uncertaintyReasons
export async function parseConversationalContext(
  companyId: string,
  pattern: string,
  userInput: string,
  userId?: string,
  fetchFn?: typeof globalThis.fetch,
  prismaClient?: typeof db,
  direction?: 'debit' | 'credit',
  locale?: string,
): Promise<ConversationalParseResult> {
  const assistantConfig = readAssistantConfigSync() as any;
  // Flatten heuristics: config has { priorities: [], rules: [] }, engine expects { heuristics: Array<{keywords, role, glAccountCode}> }
  const rawRules = assistantConfig?.heuristics?.rules ?? [];
  const flattenedRules = rawRules.map((r: any) => ({
    keywords: [...(r.keywords?.es ?? []), ...(r.keywords?.en ?? [])],
    role: r.role,
    glAccountCode: r.glAccountCode,
    direction: 'any' as const,
  }));
  const engineConfig = { heuristics: flattenedRules };
  const directionVal = direction ?? 'mixed';

  // Step 1: get EntityContext
  const existingContext = await findContext(companyId, pattern).catch(() => null);

  // Step 2: try AI (parseWithAI)
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL;
  const model = process.env.AI_MODEL;

  let aiResponse: { role?: string; glAccountCode?: string } | null = null;

  if (apiKey && baseUrl && model) {
    try {
      const parsed = await parseWithAI(pattern, userInput, {
        apiKey,
        baseUrl,
        model,
        fetch: fetchFn,
      });

      if (userId) {
        safeAuditLog({
          companyId,
          userId,
          action: 'AI_EXTERNAL_RESPONSE_RECEIVED',
          entity: 'EntityContext',
          details: {
            pattern,
            userInput,
            aiResponse: parsed,
            model,
            timestamp: new Date().toISOString(),
          },
        }).catch((e) => logger.warn('[AI AUDIT LOG FAIL]', { error: String(e) }));
      }

      if (parsed) {
        const existingAccount = await (prismaClient ?? db).glAccount.findFirst({
          where: { companyId, code: String(parsed.glAccountCode).trim(), isActive: true },
        });
        if (existingAccount) {
          aiResponse = { role: parsed.role, glAccountCode: parsed.glAccountCode };
        } else {
          logger.warn('[AI SUGGESTED CODE NOT FOUND IN DB]', {
            code: parsed.glAccountCode,
            companyId,
          });
        }
      }
    } catch {
      // AI failed — aiResponse stays null
    }
  }

  // Step 3: collect signals from all sources
  const signals = collectSignals({
    entityContext: existingContext,
    userInput,
    direction: directionVal,
    assistantConfig: engineConfig,
    aiResponse,
  }, locale);

  // Step 4: decide which signal wins
  const result = decide(signals, locale);

  // Step 5: resolve GL account from the selected signal
  if (result.selected) {
    let role = String(result.selected.role ?? '').toUpperCase().trim();
    let glAccountCode = String(result.selected.glAccountCode ?? '').trim();

    // If entity context was selected but has no assigned glAccount, resolve via ROLE_ACCOUNT_MAP
    if (!glAccountCode && existingContext) {
      const mapping = ROLE_ACCOUNT_MAP[role as EntityRole];
      if (mapping) {
        glAccountCode = direction === 'debit' ? mapping.debit
          : direction === 'credit' ? mapping.credit
          : mapping.fallback;
      }
    }

    let { glAccountId, account } = await resolveGLAccount(companyId, glAccountCode, {
      db: prismaClient,
    });

    // Auto-create known system accounts if missing
    if (!glAccountId) {
      const SYSTEM_ACCOUNTS: Record<
        string,
        { name: string; type: string; normalBalance: string; parentCode: string }
      > = {
        '3010': {
          name: "Partner Contributions / Capital",
          type: 'equity',
          normalBalance: 'credit',
          parentCode: '3000',
        },
        '3040': {
          name: "Owner's Draw / Partner Withdrawals",
          type: 'equity',
          normalBalance: 'debit',
          parentCode: '3000',
        },
      };

      const def = SYSTEM_ACCOUNTS[glAccountCode];
      if (def) {
        try {
          const client = prismaClient ?? db;
          const parent = await client.glAccount.findFirst({
            where: { companyId, code: def.parentCode, isActive: true },
          });
          const created = await client.glAccount.create({
            data: {
              companyId,
              code: glAccountCode,
              name: def.name,
              accountType: def.type,
              normalBalance: def.normalBalance,
              parentId: parent?.id ?? null,
              isActive: true,
            },
          });
          glAccountId = created.id;
          account = {
            code: created.code,
            name: created.name,
            accountType: created.accountType,
            normalBalance: created.normalBalance,
          };
          logger.info('[AUTO-CREATED SYSTEM ACCOUNT]', {
            code: glAccountCode,
            companyId,
            accountId: created.id,
          });
        } catch (createErr) {
          logger.warn('[FAILED TO AUTO-CREATE SYSTEM ACCOUNT]', {
            code: glAccountCode,
            companyId,
            error: String(createErr),
          });
        }
      }
    }

    const suggestSubAccount = role === 'SOCIO';
    const subAccountName = suggestSubAccount
      ? pattern
          .trim()
          .split(/\s+/)
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
          .join(' ')
      : null;

    const conditions: RuleCondition[] = [
      { field: 'description', operator: 'contains', value: pattern },
    ];

    return {
      role,
      glAccountCode,
      glAccountId,
      suggestSubAccount,
      subAccountName,
      account: {
        code: account.code,
        name: account.name,
        accountType: account.accountType ?? undefined,
        normalBalance: account.normalBalance ?? undefined,
      },
      conditions,
      confidence: result.confidence,
      confidenceLabel: result.confidenceLabel,
      explanation: result.explanation,
      uncertaintyReasons: result.uncertaintyReasons,
    };
  }

  // Step 6: SIN_CLASIFICAR — no signal with sufficient confidence
  return {
    role: '',
    glAccountCode: '',
    glAccountId: null,
    suggestSubAccount: false,
    subAccountName: null,
    account: { code: '', name: serverT(locale, 'accounts.unclassified') },
    conditions: [{ field: 'description', operator: 'contains', value: pattern }],
    confidence: 0,
    confidenceLabel: 'low',
    explanation: result.explanation,
    uncertaintyReasons: result.uncertaintyReasons,
  };
}
