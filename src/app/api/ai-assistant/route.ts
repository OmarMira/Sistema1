import { NextRequest, NextResponse } from 'next/server';
import ZAI from 'z-ai-web-dev-sdk';

// ─── POST /api/ai-assistant ────────────────────────────────────────
// AI chat & rule creation endpoint
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { message, mode = 'chat' } = body;

    if (!message?.trim()) {
      return NextResponse.json(
        { error: 'Message is required' },
        { status: 400 }
      );
    }

    const zai = await ZAI.create();

    if (mode === 'create-rule') {
      return handleCreateRule(zai, message);
    }

    return handleChat(zai, message);
  } catch (error) {
    console.error('[AI ASSISTANT ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ─── Chat Mode ─────────────────────────────────────────────────────
async function handleChat(zai: any, message: string) {
  const systemPrompt = `You are "Asistente Contable", a helpful and professional AI accounting assistant for the AccountExpress platform.

LANGUAGE RULES:
- Speak Spanish by default.
- If the user writes in English, respond in English.
- Be concise, clear, and professional.

YOUR CAPABILITIES:
- Answer accounting questions (GAAP, IFRS, tax, financial statements)
- Help classify transactions into correct chart of accounts
- Provide financial analysis guidance
- Suggest journal entry structures
- Explain reconciliation procedures
- Help with bank rule creation guidance
- Explain accounting concepts in simple terms

YOUR STYLE:
- Friendly but professional
- Use accounting terminology correctly
- Provide actionable advice
- When unsure, suggest consulting their CPA or tax advisor
- Format responses with clear structure when needed (bullet points, numbered lists)
- Keep responses concise but thorough`;

  const response = await zai.chat.completions.create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
  });

  const reply =
    response?.choices?.[0]?.message?.content ??
    'Lo siento, no pude procesar tu solicitud. Intenta de nuevo.';

  return NextResponse.json({ reply });
}

// ─── Create Rule Mode ──────────────────────────────────────────────
async function handleCreateRule(zai: any, message: string) {
  const systemPrompt = `You are a rule parser for the AccountExpress accounting platform. The user will describe a bank categorization rule in natural language. You must parse it into a structured JSON object.

VALID conditionType values:
- "contains" (description contains text)
- "starts_with" (description starts with text)
- "ends_with" (description ends with text)
- "equals" (description exactly matches text)
- "amount_greater" (amount is greater than value)
- "amount_less" (amount is less than value)

VALID transactionDirection values:
- "debit" (outflow/payment)
- "credit" (inflow/deposit)
- "any" (both directions)

RULES:
1. Parse the user's description to extract: name, conditionType, conditionValue, transactionDirection, glAccountName, priority
2. "priority" should be an integer from 0 to 20 (default 10 if not specified)
3. "name" should be a descriptive name for the rule
4. "conditionValue" is the text/number to match against
5. "glAccountName" is the GL account name to assign
6. Respond ONLY with a valid JSON object, no markdown, no explanation
7. If a field cannot be determined, use a reasonable default

EXAMPLE INPUT: "Contiene 'AMAZON', cuenta 'Office Supplies', prioridad 5"
EXAMPLE OUTPUT:
{"name":"AMAZON - Office Supplies","conditionType":"contains","conditionValue":"AMAZON","transactionDirection":"any","glAccountName":"Office Supplies","priority":5}

EXAMPLE INPUT: "Si el concepto comienza con 'RENTA', asignar a Rent Expense, prioridad 3"
EXAMPLE OUTPUT:
{"name":"RENTA - Rent Expense","conditionType":"starts_with","conditionValue":"RENTA","transactionDirection":"any","glAccountName":"Rent Expense","priority":3}

Respond ONLY with the JSON object.`;

  const response = await zai.chat.completions.create({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ],
  });

  const rawReply =
    response?.choices?.[0]?.message?.content ?? '';

  // Try to parse the JSON from the reply
  let parsedRule = null;
  let reply = rawReply;

  try {
    // Extract JSON from possible markdown code blocks
    const jsonMatch = rawReply.match(/```(?:json)?\s*([\s\S]*?)```/) ?? null;
    const jsonStr = jsonMatch ? jsonMatch[1].trim() : rawReply.trim();

    parsedRule = JSON.parse(jsonStr);

    // Validate required fields
    const validConditionTypes = [
      'contains',
      'starts_with',
      'ends_with',
      'equals',
      'amount_greater',
      'amount_less',
    ];
    const validDirections = ['any', 'debit', 'credit'];

    if (
      parsedRule.name &&
      parsedRule.conditionType &&
      parsedRule.conditionValue &&
      validConditionTypes.includes(parsedRule.conditionType) &&
      (parsedRule.transactionDirection === undefined ||
        validDirections.includes(parsedRule.transactionDirection))
    ) {
      // Normalize defaults
      parsedRule.transactionDirection =
        parsedRule.transactionDirection ?? 'any';
      parsedRule.priority =
        typeof parsedRule.priority === 'number'
          ? Math.min(20, Math.max(0, Math.round(parsedRule.priority)))
          : 10;
      parsedRule.glAccountName = parsedRule.glAccountName ?? '';

      reply =
        '✅ Regla analizada exitosamente. Revisa los campos y guarda la regla.';
    } else {
      parsedRule = null;
      reply =
        '⚠️ No se pudo interpretar completamente la regla. Por favor, verifica el formato e intenta de nuevo.\n\nFormato sugerido: \'Contiene "TEXTO", cuenta "Nombre de Cuenta", prioridad 5\'';
    }
  } catch {
    parsedRule = null;
    reply =
      '⚠️ Error al analizar la regla. Por favor, describe la regla con más detalle.\n\nEjemplo: \'Contiene "AMAZON", cuenta "Office Supplies", prioridad 5\'';
  }

  return NextResponse.json({
    reply,
    ...(parsedRule ? { parsedRule } : {}),
  });
}
