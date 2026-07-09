import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { ENTITY_ROLES, EXPECTED_DIRECTION } from '@/lib/constants/entity-roles';
import type { EntityRole } from '@/lib/constants/entity-roles';
import { checkPromptInjection } from '@/lib/guardrails';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { requireCompanyContext } from '@/lib/context-storage';
import { roleIsValidForDirection } from '@/lib/services/direction-filter';
import { searchEntity } from '@/lib/services/web-search-service';
import { getAiConfig } from '@/lib/ai-config';

// ── POST /api/learning/suggest-role ──────────────────────────────────
// Hybrid suggest: searches local EntityContext first, falls back to AI.
export const POST = apiHandler(async (request: NextRequest, context: RouteContext) => {
  try {
    const body = await request.json();
    const { companyId } = requireCompanyContext();
    const { description, directionProfile, sampleDescriptions, totalAmount, occurrences, manualRequest } = body as {
      description?: string;
      directionProfile?: { creditPct: number; debitPct: number };
      sampleDescriptions?: string[];
      totalAmount?: { min: number; max: number };
      occurrences?: number;
      manualRequest?: boolean;
    };

    // Validate input: description is required, min 3 chars
    if (!description || typeof description !== 'string' || description.trim().length < 3) {
      return NextResponse.json(
        { error: 'Description is required (min 3 characters)' },
        { status: 400 },
      );
    }

    const trimmedDesc = description.trim();

    // ── Query company autoRoleAssignment flag ──
    let autoRoleAssignment = false;
    const company = await db.company.findUnique({
      where: { id: companyId },
      select: { autoRoleAssignment: true },
    });
    autoRoleAssignment = company?.autoRoleAssignment ?? false;

    // ── Fetch unique company roles (excluding base roles and OTRO) ──
    const companyContexts = await db.entityContext.findMany({
      where: { companyId },
      select: { role: true },
      distinct: ['role'],
    });
    const companyRoles = [...new Set(
      companyContexts
        .map((c) => c.role.trim().toUpperCase())
        .filter((r) => r && r !== 'OTRO' && !ENTITY_ROLES.includes(r as EntityRole))
    )];

    // ── Phase 1: local DB search ──────────────
    const localMatch = await findLocalMatch(trimmedDesc, companyId);
    if (localMatch) {
      logger.info('[SUGGEST_ROLE LOCAL_MATCH]', {
        description: trimmedDesc,
        match: localMatch,
      });
      const matchRole = localMatch.suggestedRole.trim().toUpperCase();
      const localIsNewRole = !ENTITY_ROLES.includes(matchRole as EntityRole) && !companyRoles.includes(matchRole);
      const localRoleSource = ENTITY_ROLES.includes(matchRole as EntityRole)
        ? 'BASE_ROLE'
        : companyRoles.includes(matchRole)
          ? 'COMPANY_ROLE'
          : 'NEW_ROLE_CANDIDATE';
      if (autoRoleAssignment && localMatch.confidence >= 0.9) {
        return NextResponse.json({
          ...localMatch,
          isNewRole: localIsNewRole,
          roleSource: localRoleSource,
          autoAssign: true,
        });
      }
      return NextResponse.json({
        ...localMatch,
        isNewRole: localIsNewRole,
        roleSource: localRoleSource,
      });
    }

    // ── Phase 2: AI fallback ─────────────────────────────────────────

    // Prompt injection guardrails
    const injectionCheck = checkPromptInjection(trimmedDesc);
    if (!injectionCheck.passed) {
      logger.warn('SUGGEST_ROLE_PROMPT_INJECTION_BLOCKED', { reason: injectionCheck.reason });
      return NextResponse.json(
        { error: 'Disallowed content detected in input.' },
        { status: 400 },
      );
    }

    // Read AI configuration from DB (encrypted) with env fallback
    let apiKey: string;
    let baseUrl: string;
    let model: string;
    try {
      const aiConfig = await getAiConfig();
      apiKey = aiConfig.apiKey;
      baseUrl = aiConfig.baseUrl;
      model = aiConfig.model;
    } catch {
      logger.error('SUGGEST_ROLE_MISSING_AI_CONFIG');
      return NextResponse.json(
        { error: 'AI not configured. Set it up in Settings → AI.', code: 'AI_NOT_CONFIGURED' },
        { status: 502 },
      );
    }

    if (!apiKey || !baseUrl || !model) {
      logger.error('SUGGEST_ROLE_MISSING_AI_CONFIG');
      return NextResponse.json(
        { error: 'AI not configured. Set it up in Settings → AI.', code: 'AI_NOT_CONFIGURED' },
        { status: 502 },
      );
    }

    // Filter roles by direction profile (if provided)
    let candidateRoles: string[] = [...ENTITY_ROLES];
    if (directionProfile) {
      const filteredOut: string[] = [];
      candidateRoles = ENTITY_ROLES.filter((role) => {
        const result = roleIsValidForDirection(role, directionProfile);
        if (!result.valid) {
          filteredOut.push(role);
        }
        return result.valid;
      });

      if (filteredOut.length > 0) {
        logger.info('[SUGGEST_ROLE DIRECTION_FILTER]', {
          filteredOut,
          profile: directionProfile,
          remaining: candidateRoles,
        });
      }
    }

    // Fetch company profile for richer AI context
    let companyProfile: string | null = null;
    try {
      const company = await db.company.findUnique({
        where: { id: companyId },
        select: { legalName: true, entityType: true, taxId: true },
      });
      if (company) {
        const parts: string[] = [`Company: ${company.legalName}`];
        if (company.entityType) {
          parts.push(`Entity type: ${company.entityType}`);
        }
        if (company.taxId) {
          parts.push(`Tax ID: ${company.taxId}`);
        }
        companyProfile = parts.join(' | ');
        logger.info('[SUGGEST_ROLE COMPANY_PROFILE]', { companyId, legalName: company.legalName });
      }
    } catch (err) {
      logger.warn('[SUGGEST_ROLE COMPANY_PROFILE_FETCH_FAILED]', { companyId, error: String(err) });
      // Non-fatal — proceed without profile
    }

    // Build the focused prompt for role suggestion
    const baseRolesList = candidateRoles.map((r) => `- ${r}`).join('\n');
    const companyRolesList = companyRoles.length > 0
      ? companyRoles.map((r) => `- ${r}`).join('\n')
      : '- (none yet)';

    // Rich context section
    const contextParts: string[] = [];
    if (companyProfile) {
      contextParts.push(companyProfile);
    }
    contextParts.push(`Description: ${trimmedDesc}`);
    if (occurrences !== undefined && occurrences > 0) {
      contextParts.push(`Transactions: ${occurrences}`);
    }

    if (directionProfile) {
      const creditPct = Math.round(directionProfile.creditPct * 100);
      const debitPct = Math.round(directionProfile.debitPct * 100);
      contextParts.push(
        `This entity has ${debitPct}% debit transactions (money OUT) and ${creditPct}% credit transactions (money IN)`,
      );
      contextParts.push(
        'Direction is evidence only. Never exclude a role based solely on debit/credit direction. SOCIO can be debit-only. PRESTAMO and TARJETA_CREDITO are typically debit-only. INGRESO is typically credit-only.',
      );
    }

    // Sample descriptions (up to 3)
    if (sampleDescriptions && sampleDescriptions.length > 0) {
      const samples = sampleDescriptions.slice(0, 3);
      contextParts.push('Sample descriptions:');
      for (const s of samples) {
        contextParts.push(`  - ${s}`);
      }
    }

    // Total amount accumulated
    if (totalAmount) {
      contextParts.push(`Total amount: $${totalAmount.min}`);
    }

    const contextBlock = contextParts.join('\n');

    const systemPrompt = `You are an accounting entity classifier. Return only valid JSON.

ROLE DEFINITIONS:
- INQUILINO: Tenant who pays rent monthly (money flows IN to company)
- PROVEEDOR: Vendor/supplier paid for goods/services (money flows OUT)
- SOCIO: Business partner/owner with mixed transactions (deposits, withdrawals, transfers)
- CLIENTE: Customer who pays for services (money flows IN)
- EMPLEADO: Employee receiving salary/payroll (money flows OUT)
- TARJETA_CREDITO: Credit card payments (money flows OUT)
- PRESTAMO: Loan payments (money flows OUT)
- GASTO_OPERATIVO: Operating expense (money flows OUT)
- INGRESO: Income/revenue source (money flows IN)

RULES:
1. Evaluate base roles first, but if a custom or new role (like HOLDING, EMPRESA_SOCIO, INVERSOR) describes the entity's purpose MORE precisely than any base role, PRIORITIZE the more specific role.
2. If an EXISTING company role already used by this company fits well, prefer it over a base role.
3. Suggest a NEW concise role when it captures the entity better than any base or company role.
4. Never return OTRO as a final role.
5. Return the role in UPPERCASE.

EXAMPLES:
- "Home Depot" → PROVEEDOR (base role match)
- "Uber" → PLATAFORMA (new role suggestion — no base/company role fits)
- "LQ&OM INVESTMENT LLC" → HOLDING (new role suggestion)
- "Rodrigo Ochoa (renta)" → INQUILINO (base role match)`;

    const userPrompt = `Given this entity:
${contextBlock}

Base roles available:
${baseRolesList}

Roles already used by this company:
${companyRolesList}

Return ONLY valid JSON with this exact format: { "role": "ROLE_NAME", "confidence": 0.85, "explanation": "brief reason" }
The confidence MUST be a decimal number like 0.85, not a string or text. Follow the rules in order: evaluate specificity → prefer company role → suggest new role if more precise.`;

    let aiResult: { role: string; confidence: number; explanation: string } | null = null;
    let lastError: string | null = null;

    let modelsToTry = [model];
    if (model === 'openrouter/free') {
      modelsToTry = ['google/gemma-4-31b-it:free', 'openrouter/free'];
    }

    for (const currentModel of modelsToTry) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);

      try {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
          },
          body: JSON.stringify({
            model: currentModel,
            temperature: 0.1,
            max_tokens: 1000,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: userPrompt },
            ],
          }),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          throw new Error(`AI API returned status ${response.status}`);
        }

        const resData = await response.json();
        const content: string | undefined = resData.choices?.[0]?.message?.content;
        if (!content) {
          throw new Error('AI response missing content');
        }

        aiResult = parseSuggestion(content);

        if (!aiResult) {
          logger.warn('[SUGGEST_ROLE PARSE_FAILED]', {
            preview: content.substring(0, 300),
            length: content.length,
          });
          throw new Error('Could not extract role from AI response');
        }

        // Successfully resolved role suggestion, break out of loop
        logger.info('[SUGGEST_ROLE SUCCESS]', { model: currentModel });
        break;
      } catch (err: unknown) {
        clearTimeout(timeout);
        lastError = err instanceof Error ? err.message : String(err);
        logger.warn('[SUGGEST_ROLE MODEL_FAILED]', { model: currentModel, error: lastError });
      }
    }

    // ── Phase 3: Web search fallback for low-confidence results ──
    if (aiResult && aiResult.confidence < 0.80 && process.env.WEB_SEARCH_ENABLED === 'true') {
      const webResult = await searchEntity(trimmedDesc);

      if (webResult) {
        logger.info('[SUGGEST_ROLE WEB_SEARCH_REPROMPT]', {
          entity: trimmedDesc,
          title: webResult.title,
        });

        const rePrompt = `Web search result for "${trimmedDesc}":
Title: ${webResult.title}
Snippet: ${webResult.snippet}
Source: ${webResult.sourceUrl}

Based on this additional context, re-evaluate the role.`;

        const rePromptMessages = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
          { role: 'user', content: rePrompt },
        ];

        const reController = new AbortController();
        const reTimeout = setTimeout(() => reController.abort(), 60000);

        try {
          const reResponse = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
            },
            body: JSON.stringify({
              model,
              temperature: 0.1,
              max_tokens: 1000,
              messages: rePromptMessages,
            }),
            signal: reController.signal,
          });

          clearTimeout(reTimeout);

          if (reResponse.ok) {
            const reData = await reResponse.json();
            const reContent: string | undefined = reData.choices?.[0]?.message?.content;

            if (reContent) {
              const reResult = parseSuggestion(reContent);

              if (reResult && reResult.confidence > aiResult.confidence) {
                const previousConfidence = aiResult.confidence;
                const originalReConfidence = reResult.confidence;

                // Cap web-search-driven confidence at 0.70
                reResult.confidence = Math.min(reResult.confidence, 0.70);

                aiResult = reResult;

                logger.info('[SUGGEST_ROLE WEB_SEARCH_IMPROVED]', {
                  entity: trimmedDesc,
                  previousConfidence,
                  newRole: reResult.role,
                  capApplied: originalReConfidence > 0.70,
                });
              }
            }
          }
        } catch {
          logger.warn('[SUGGEST_ROLE WEB_SEARCH_REPROMPT_FAILED]', {
            entity: trimmedDesc,
          });
        } finally {
          clearTimeout(reTimeout);
        }
      }
    }

    if (!aiResult) {
      // Last resort: try local fallback
      const fallback = await findLocalMatch(trimmedDesc, companyId);
      if (fallback) {
        logger.info('[SUGGEST_ROLE AI_FAILED_LOCAL_FALLBACK]', {
          description: trimmedDesc,
          fallback,
        });
        const fbRole = fallback.suggestedRole.trim().toUpperCase();
        const fbIsNewRole = !ENTITY_ROLES.includes(fbRole as EntityRole) && !companyRoles.includes(fbRole);
        const fbRoleSource = ENTITY_ROLES.includes(fbRole as EntityRole)
          ? 'BASE_ROLE'
          : companyRoles.includes(fbRole)
            ? 'COMPANY_ROLE'
            : 'NEW_ROLE_CANDIDATE';
        return NextResponse.json({ ...fallback, isNewRole: fbIsNewRole, roleSource: fbRoleSource });
      }
      return NextResponse.json(
        { error: 'AI service did not respond. Please try again.', code: 'AI_REQUEST_FAILED' },
        { status: 502 },
      );
    }

    // ── Validate & classify the suggested role ──
    const suggestedRole = aiResult.role.trim().toUpperCase();
    if (!suggestedRole) {
      logger.warn('[SUGGEST_ROLE EMPTY_ROLE]', { role: aiResult.role });
      return NextResponse.json(
        { error: 'AI returned an empty role. Please try again.', code: 'AI_INVALID_ROLE' },
        { status: 502 },
      );
    }
    if (suggestedRole === 'OTRO') {
      logger.warn('[SUGGEST_ROLE OTRO_REJECTED]', { role: aiResult.role });
      return NextResponse.json(
        { error: 'AI returned OTRO. Please try again or assign manually.', code: 'AI_INVALID_ROLE' },
        { status: 502 },
      );
    }
    if (suggestedRole.length > 50) {
      logger.warn('[SUGGEST_ROLE_ROLE_TOO_LONG]', { role: suggestedRole });
      return NextResponse.json(
        { error: 'AI returned a role that is too long. Please try again.', code: 'AI_INVALID_ROLE' },
        { status: 502 },
      );
    }
    if (!/^[A-Z][A-Z0-9_ ]*$/.test(suggestedRole)) {
      logger.warn('[SUGGEST_ROLE_INVALID_CHARS]', { role: suggestedRole });
      return NextResponse.json(
        { error: 'AI returned a role with invalid characters. Please try again.', code: 'AI_INVALID_ROLE' },
        { status: 502 },
      );
    }
    aiResult.role = suggestedRole;

    // Determine if this role is new to the company
    const isNewRole = !ENTITY_ROLES.includes(suggestedRole as EntityRole) && !companyRoles.includes(suggestedRole);
    const roleSource = ENTITY_ROLES.includes(suggestedRole as EntityRole)
      ? 'BASE_ROLE'
      : companyRoles.includes(suggestedRole)
        ? 'COMPANY_ROLE'
        : 'NEW_ROLE_CANDIDATE';

    // ── LLM confidence cap (conditional on autoRoleAssignment + manualRequest) ──
    // When autoRoleAssignment is enabled, let confidence flow uncapped.
    // When user explicitly requests a suggestion (manualRequest), skip the cap.
    // Otherwise, force to max 0.69 (treated as LOW by frontend confidence gate).
    if (!autoRoleAssignment && !manualRequest) {
      aiResult.confidence = Math.min(aiResult.confidence, 0.69);
    }

    const response: Record<string, unknown> = {
      suggestedRole: aiResult.role,
      confidence: aiResult.confidence,
      explanation: aiResult.explanation,
      isNewRole,
      roleSource,
      reasoning: `No existing rule or entity context found for pattern. Suggested role: ${aiResult.role}.`,
    };

    if (autoRoleAssignment && aiResult.confidence >= 0.9) {
      response.autoAssign = true;
    }

    return NextResponse.json(response);
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    logger.error('[SUGGEST_ROLE ERROR]', { error: msg });
    return NextResponse.json(
      { error: 'An unexpected error occurred. Please try again.', code: 'AI_INTERNAL_ERROR' },
      { status: 500 },
    );
  }
}, { requireMembership: true });

/**
 * Two-pass parser for AI suggestion responses.
 *
 * Pass 1 — JSON.parse: works when the model returns clean JSON.
 * Pass 2 — regex extraction: salvages truncated or malformed JSON
 *            by scanning for role, confidence, and explanation fields.
 *
 * Returns null if neither pass can extract the required fields.
 */
function parseSuggestion(content: string): { role: string; confidence: number; explanation: string } | null {
  // ── Pass 1: strict JSON ──────────────────────────────────────────
  try {
    const parsed = JSON.parse(content);
    const role = parsed.role ?? parsed.suggestedRole ?? null;
    const confidence = parsed.confidence ?? null;
    const explanation = parsed.explanation ?? null;

    if (role && confidence !== null && explanation) {
      return {
        role: String(role).toUpperCase().trim(),
        confidence: Number(confidence),
        explanation: String(explanation),
      };
    }
  } catch {
    // Malformed JSON — fall through to regex pass
  }

  // ── Pass 2: regex extraction for truncated/malformed JSON ────────
  const roleMatch = content.match(/"role"\s*:\s*"([^"]+)"/i)
                ?? content.match(/"suggestedRole"\s*:\s*"([^"]+)"/i);
  const confidenceMatch = content.match(/"confidence"\s*:\s*([0-9]+\.?[0-9]*)/i);
  const explanationMatch = content.match(/"explanation"\s*:\s*"([^"]+)"/i);

  if (roleMatch && confidenceMatch) {
    return {
      role: roleMatch[1].toUpperCase().trim(),
      confidence: parseFloat(confidenceMatch[1]),
      explanation: explanationMatch?.[1] ?? '',
    };
  }

  return null;
}

// ── Local DB search ──────────────────────────────────────────────────
// Searches the company's existing EntityContext for a description that
// shares significant tokens with the input. Returns a match if the
// token overlap score meets the confidence threshold.
interface LocalMatchResult {
  suggestedRole: string;
  confidence: number;
  explanation: string;
}

/**
 * Tokenize a string into significant words (lowercased, length > 2).
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,_\-]+/)
    .filter((t) => t.length > 2 && !/^\d+$/.test(t));
}

/**
 * Jaccard similarity between two sets of tokens.
 * Returns 0–1 score measuring token overlap.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersection = a.filter((t) => setB.has(t)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * Enhanced score: max of Jaccard and containment (input-contained-in-pattern),
 * weighted toward direct token overlap. Prefers matches where significant
 * input tokens appear in the stored pattern.
 */
function scoreTokens(inputTokens: string[], patternTokens: string[]): number {
  const jaccard = jaccardSimilarity(inputTokens, patternTokens);

  // Containment: what fraction of input tokens appear in the pattern?
  const inputSet = new Set(inputTokens);
  const patternSet = new Set(patternTokens);
  const containment =
    inputTokens.length > 0
      ? inputTokens.filter((t) => patternSet.has(t)).length / inputTokens.length
      : 0;

  // Also check inverse containment (pattern fully contained in input)
  const invContainment =
    patternTokens.length > 0
      ? patternTokens.filter((t) => inputSet.has(t)).length / patternTokens.length
      : 0;

  return Math.max(jaccard, containment * 0.85, invContainment * 0.7);
}

async function findLocalMatch(
  description: string,
  companyId: string,
): Promise<LocalMatchResult | null> {
  const contexts = await db.entityContext.findMany({
    where: { companyId },
    select: { pattern: true, role: true },
  });

  if (contexts.length === 0) return null;

  const inputTokens = tokenize(description);
  // If description has no significant tokens, can't match
  if (inputTokens.length === 0) return null;

  let bestScore = 0;
  let bestMatch: { pattern: string; role: string } | null = null;

  for (const ctx of contexts) {
    const patternTokens = tokenize(ctx.pattern);
    if (patternTokens.length === 0) continue;

    // Exact match (ignoring case) → immediate return with max confidence
    if (ctx.pattern.toLowerCase() === description.toLowerCase()) {
      return {
        suggestedRole: ctx.role,
        confidence: 0.98,
        explanation: `Exact match with "${ctx.pattern}" in local context`,
      };
    }

    const score = scoreTokens(inputTokens, patternTokens);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { pattern: ctx.pattern, role: ctx.role };
    }
  }

  if (bestMatch && bestScore >= 0.45) {
    return {
      suggestedRole: bestMatch.role,
      confidence: Math.round(bestScore * 100) / 100,
      explanation: `Matched "${bestMatch.pattern}" in local context (${Math.round(bestScore * 100)}%)`,
    };
  }

  return null;
}

