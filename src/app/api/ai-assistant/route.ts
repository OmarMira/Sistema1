import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { logger } from '@/lib/logger';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { getRequestContext } from '@/lib/context-storage';
import { AI_CONFIG } from '@/lib/constants/ai-config';
import { createAuditLogWithRetry } from '@/lib/audit';
import { extractKeywords } from '@/lib/memory/keyword-extractor';
import { checkPromptInjection, addSystemDelimiter } from '@/lib/guardrails';
import { join } from 'path';
import { readFileSync, existsSync } from 'fs';
import type { AiChatMessage, AiToolCall, ParsedRuleFromAI } from '@/lib/types/shared';
import { Prisma } from '@prisma/client';

// ─── Request schema ─────────────────────────────────────────────────
const RequestBodySchema = z.object({
  message: z.string().min(1, 'Message is required'),
  mode: z.enum(['chat', 'create-rule']).default('chat'),
  companyId: z.string().optional(),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      }),
    )
    .optional(),
  isWarmup: z.boolean().optional(),
});

// ─── AI response schema ─────────────────────────────────────────────
const ToolCallSchema = z.object({
  id: z.string(),
  type: z.literal('function'),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
});
const AIChoiceSchema = z.object({
  message: z.object({
    role: z.string().optional(),
    content: z.string().nullable().optional(),
    tool_calls: z.array(ToolCallSchema).optional(),
  }),
});
const AIResponseSchema = z.object({
  choices: z.array(AIChoiceSchema).optional(),
});

// ─── Parsed rule schema V2 ──────────────────────────────────────────
const ConditionV2Schema = z.object({
  field: z.enum(['description', 'amount']),
  operator: z.enum([
    'contains',
    'starts_with',
    'ends_with',
    'equals',
    'amount_greater',
    'amount_less',
  ]),
  value: z.union([z.string(), z.number()]),
});

const ParsedRuleV2Schema = z.object({
  name: z.string().default(''),
  conditions: z.array(ConditionV2Schema).default([]),
  debitGlAccountName: z.string().optional().nullable(),
  creditGlAccountName: z.string().optional().nullable(),
  glAccountName: z.string().optional().nullable(),
  transactionDirection: z.enum(['any', 'debit', 'credit']).default('any'),
  priority: z.coerce.number().int().min(0).max(20).default(10),
  confidence: z.coerce.number().min(0).max(1).optional(),
  confidenceLabel: z.enum(['high', 'medium', 'low']).optional(),
});

// ─── TOOLS definition ───────────────────────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_company_summary',
      description:
        'Obtiene un resumen de la empresa actual, incluyendo nombre legal, RFC/taxId, cantidad de cuentas bancarias y cantidad total de transacciones registradas.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_bank_accounts',
      description:
        'Obtiene la lista de cuentas bancarias de la empresa actual con sus detalles: nombre, banco, número de cuenta, saldo actual y moneda.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_bank_rules',
      description: 'Obtiene las reglas de categorización automática de la empresa.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_gl_accounts',
      description: 'Obtiene el Plan de Cuentas (Cuentas de Mayor / GL Accounts) de la empresa.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_bank_transactions',
      description:
        'Busca y filtra transacciones bancarias de la empresa actual. Permite filtrar por texto en la descripción (búsqueda parcial), rango de montos, rango de fechas y si están conciliadas.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Texto a buscar en la descripción de la transacción.',
          },
          minAmount: {
            type: 'number',
            description: 'Monto mínimo de la transacción.',
          },
          maxAmount: {
            type: 'number',
            description: 'Monto máximo de la transacción.',
          },
          startDate: {
            type: 'string',
            description: 'Fecha de inicio en formato ISO (YYYY-MM-DD).',
          },
          endDate: {
            type: 'string',
            description: 'Fecha de fin en formato ISO (YYYY-MM-DD).',
          },
          isReconciled: {
            type: 'boolean',
            description: 'Filtrar por estado de conciliación (true/false).',
          },
          limit: {
            type: 'number',
            description: 'Límite de transacciones a retornar (por defecto 50, máximo 100).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_transaction_stats',
      description:
        'Calcula estadísticas acumuladas de las transacciones (total count, sumas, mínimos, máximos y promedios) para responder preguntas sobre totales generales. Puedes filtrar por descripción (ej. nombre de socio).',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Texto a buscar en la descripción de las transacciones.',
          },
          startDate: {
            type: 'string',
            description: 'Fecha de inicio en formato ISO (YYYY-MM-DD).',
          },
          endDate: {
            type: 'string',
            description: 'Fecha de fin en formato ISO (YYYY-MM-DD).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_entity_contexts',
      description:
        'Obtiene la lista de entidades clasificadas en el sistema (socios, proveedores, clientes, inquilinos) con sus respectivos roles y cuentas contables asociadas.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Buscar por patrón de nombre de la entidad.' },
          role: {
            type: 'string',
            description:
              'Filtrar por rol de la entidad (ej: "SOCIO", "PROVEEDOR", "INQUILINO", "CLIENTE").',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_journal_entries',
      description:
        'Busca y obtiene los asientos contables (Journal Entries) registrados en el libro diario de la empresa.',
      parameters: {
        type: 'object',
        properties: {
          startDate: { type: 'string', description: 'Fecha de inicio en formato ISO (YYYY-MM-DD).' },
          endDate: { type: 'string', description: 'Fecha de fin en formato ISO (YYYY-MM-DD).' },
          status: {
            type: 'string',
            enum: ['draft', 'posted'],
            description: 'Filtrar por estado del asiento.',
          },
          limit: { type: 'number', description: 'Límite de asientos contables a retornar.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_fiscal_periods',
      description:
        'Obtiene la lista de periodos fiscales configurados para la empresa actual y su estado de bloqueo (cerrado/abierto).',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reconciliation_periods',
      description:
        'Obtiene los periodos de conciliación bancaria y sus saldos, diferencias y estado.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_bank_statements',
      description:
        'Lista los estados de cuenta bancarios cargados en el sistema con sus fechas y saldos.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_users',
      description: 'Obtiene la lista de usuarios del sistema y sus roles/estados.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_audit_logs',
      description:
        'Obtiene el registro de logs de auditoría de los cambios y acciones recientes en el sistema.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Límite de registros a retornar.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'save_system_memory',
      description:
        'Guarda un hecho importante, preferencia de usuario o decisión contable en la memoria a largo plazo del sistema para recordar en futuras sesiones.',
      parameters: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Título corto de la memoria (ej: Rol de socio de Omar Mira)',
          },
          content: { type: 'string', description: 'Descripción detallada del hecho o preferencia' },
          type: { type: 'string', enum: ['preference', 'decision', 'fact', 'rule_context'] },
          keywords: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Palabras clave importantes para la recuperación posterior (ej: ["omar", "mira", "socio"])',
          },
        },
        required: ['title', 'content', 'type', 'keywords'],
      },
    },
  },
];

// Local execution of DB queries using Prisma
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  companyId: string,
  userId?: string,
) {
  try {
    switch (name) {
      case 'get_company_summary': {
        const bankAccountCount = await db.bankAccount.count({ where: { companyId } });
        const transactionCount = await db.bankTransaction.count({
          where: { statement: { companyId } },
        });
        const ruleCount = await db.bankRule.count({ where: { companyId } });
        const glAccountCount = await db.glAccount.count({ where: { companyId } });
        const company = await db.company.findUnique({
          where: { id: companyId },
          select: { legalName: true, taxId: true, address: true, phone: true, email: true },
        });
        return {
          companyName: company?.legalName || 'Desconocida',
          taxId: company?.taxId || 'No asignado',
          totalBankAccounts: bankAccountCount,
          totalTransactions: transactionCount,
          totalRules: ruleCount,
          totalGlAccounts: glAccountCount,
        };
      }

      case 'get_bank_accounts': {
        const accounts = await db.bankAccount.findMany({
          where: { companyId, isActive: true },
          select: {
            id: true,
            accountName: true,
            bankName: true,
            accountNo: true,
            balance: true,
            currency: true,
          },
        });
        return accounts;
      }

      case 'get_bank_rules': {
        const rules = await db.bankRule.findMany({
          where: { companyId, isActive: true },
          include: {
            glAccount: {
              select: { name: true, code: true },
            },
          },
          orderBy: { priority: 'desc' },
        });
        return rules.map((r) => ({
          id: r.id,
          name: r.name,
          conditionType: r.conditionType,
          conditionValue: r.conditionValue,
          transactionDirection: r.transactionDirection,
          glAccount: r.glAccount ? `${r.glAccount.code} - ${r.glAccount.name}` : 'Ninguna',
          priority: r.priority,
        }));
      }

      case 'get_gl_accounts': {
        const glAccounts = await db.glAccount.findMany({
          where: { companyId, isActive: true },
          select: {
            id: true,
            code: true,
            name: true,
            accountType: true,
            normalBalance: true,
          },
          orderBy: { code: 'asc' },
        });
        return glAccounts;
      }

      case 'get_bank_transactions': {
        const description = args.description as string | undefined;
        const minAmount = args.minAmount as number | undefined;
        const maxAmount = args.maxAmount as number | undefined;
        const startDate = args.startDate as string | undefined;
        const endDate = args.endDate as string | undefined;
        const isReconciled = args.isReconciled as boolean | undefined;
        const limit = args.limit as number | undefined;
         
        const where: any = {
          statement: { companyId },
        };

        if (description) {
          where.description = { contains: description };
        }
        if (isReconciled !== undefined && isReconciled !== null) {
          where.isReconciled = isReconciled;
        }
        if (minAmount !== undefined || maxAmount !== undefined) {
          where.amount = {};
          if (minAmount !== undefined) where.amount.gte = minAmount;
          if (maxAmount !== undefined) where.amount.lte = maxAmount;
        }
        if (startDate || endDate) {
          where.date = {};
          if (startDate) where.date.gte = new Date(startDate);
          if (endDate) where.date.lte = new Date(endDate);
        }

        const limitVal = Math.min(limit || 50, 100);

        const transactions = await db.bankTransaction.findMany({
          where,
          take: limitVal,
          orderBy: { date: 'desc' },
          select: {
            id: true,
            date: true,
            description: true,
            amount: true,
            isReconciled: true,
            reference: true,
            glAccount: {
              select: { name: true, code: true },
            },
          },
        });

        return transactions.map((t) => ({
          id: t.id,
          date: t.date.toISOString().split('T')[0],
          description: t.description,
          amount: t.amount,
          isReconciled: t.isReconciled,
          reference: t.reference,
          glAccount: t.glAccount ? `${t.glAccount.code} - ${t.glAccount.name}` : 'Sin clasificar',
        }));
      }

      case 'get_transaction_stats': {
        const description = args.description as string | undefined;
        const startDate = args.startDate as string | undefined;
        const endDate = args.endDate as string | undefined;
        
         
        const where: any = { statement: { companyId } };

        if (description) {
          where.description = { contains: description };
        }
        if (startDate || endDate) {
          where.date = {};
          if (startDate) where.date.gte = new Date(startDate);
          if (endDate) where.date.lte = new Date(endDate);
        }

        const totalCount = await db.bankTransaction.count({ where });
        const reconciledCount = await db.bankTransaction.count({
          where: { ...where, isReconciled: true },
        });
        const unreconciledCount = totalCount - reconciledCount;

        const aggregations = await db.bankTransaction.aggregate({
          where,
          _sum: {
            amount: true,
          },
          _avg: {
            amount: true,
          },
          _min: {
            amount: true,
          },
          _max: {
            amount: true,
          },
        });

        return {
          totalCount,
          reconciledCount,
          unreconciledCount,
          sumOfAmounts: aggregations._sum.amount || 0,
          averageAmount: aggregations._avg.amount || 0,
          minAmount: aggregations._min.amount || 0,
          maxAmount: aggregations._max.amount || 0,
        };
      }

      case 'get_entity_contexts': {
        const search = args.search as string | undefined;
        const role = args.role as string | undefined;
         
        const where: any = { companyId };
        if (search) {
          where.pattern = { contains: search };
        }
        if (role) {
          where.role = role;
        }
        const entities = await db.entityContext.findMany({
          where,
          include: {
            glAccount: {
              select: { name: true, code: true },
            },
          },
          orderBy: { pattern: 'asc' },
        });
        return entities.map((e) => ({
          id: e.id,
          pattern: e.pattern,
          role: e.role,
          glAccount: e.glAccount ? `${e.glAccount.code} - ${e.glAccount.name}` : 'Ninguna',
          source: e.source,
          createdAt: e.createdAt.toISOString().split('T')[0],
        }));
      }

      case 'get_journal_entries': {
        const startDate = args.startDate as string | undefined;
        const endDate = args.endDate as string | undefined;
        const status = args.status as string | undefined;
        const limit = args.limit as number | undefined;
         
        const where: any = { companyId };
        if (status) {
          where.status = status;
        }
        if (startDate || endDate) {
          where.date = {};
          if (startDate) where.date.gte = new Date(startDate);
          if (endDate) where.date.lte = new Date(endDate);
        }
        const limitVal = Math.min(limit || 50, 100);
        const entries = await db.journalEntry.findMany({
          where,
          take: limitVal,
          orderBy: { date: 'desc' },
          include: {
            lines: {
              include: {
                glAccount: {
                  select: { name: true, code: true },
                },
              },
            },
          },
        });
        return entries.map((e) => ({
          id: e.id,
          date: e.date.toISOString().split('T')[0],
          description: e.description,
          reference: e.reference,
          status: e.status,
          lines: e.lines.map((l) => ({
            id: l.id,
            account: `${l.glAccount.code} - ${l.glAccount.name}`,
            debit: l.debit,
            credit: l.credit,
            description: l.description,
          })),
        }));
      }

      case 'get_fiscal_periods': {
        const periods = await db.fiscalPeriod.findMany({
          where: { companyId },
          orderBy: { startDate: 'asc' },
        });
        return periods.map((p) => ({
          id: p.id,
          name: p.name,
          startDate: p.startDate.toISOString().split('T')[0],
          endDate: p.endDate.toISOString().split('T')[0],
          isLocked: p.isLocked,
        }));
      }

      case 'get_reconciliation_periods': {
        const periods = await db.reconciliationPeriod.findMany({
          where: { companyId },
          include: {
            bankAccount: {
              select: { accountName: true, bankName: true },
            },
            user: {
              select: { firstName: true, lastName: true, email: true },
            },
          },
          orderBy: { startedAt: 'desc' },
        });
        return periods.map((p) => ({
          id: p.id,
          bankAccount: `${p.bankAccount.bankName} - ${p.bankAccount.accountName}`,
          user: `${p.user.firstName} ${p.user.lastName} (${p.user.email})`,
          statementBalance: p.statementBalance,
          bookBalance: p.bookBalance,
          difference: p.difference,
          status: p.status,
          startedAt: p.startedAt.toISOString().split('T')[0],
          completedAt: p.completedAt ? p.completedAt.toISOString().split('T')[0] : null,
          transactionCount: p.transactionCount,
        }));
      }

      case 'get_bank_statements': {
        const statements = await db.bankStatement.findMany({
          where: { companyId },
          include: {
            bankAccount: {
              select: { accountName: true, bankName: true },
            },
          },
          orderBy: { endDate: 'desc' },
        });
        return statements.map((s) => ({
          id: s.id,
          bankAccount: `${s.bankAccount.bankName} - ${s.bankAccount.accountName}`,
          startDate: s.startDate.toISOString().split('T')[0],
          endDate: s.endDate.toISOString().split('T')[0],
          openingBalance: s.openingBalance,
          closingBalance: s.closingBalance,
          totalCredits: s.totalCredits,
          totalDebits: s.totalDebits,
          format: s.format,
          fileName: s.fileName,
        }));
      }

      case 'get_users': {
        const members = await db.companyMember.findMany({
          where: { companyId },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
                role: true,
                isActive: true,
              },
            },
          },
        });
        return members.map((m) => ({
          id: m.user.id,
          name: `${m.user.firstName} ${m.user.lastName}`,
          email: m.user.email,
          role: m.user.role,
          companyRole: m.role,
          isActive: m.user.isActive,
        }));
      }

      case 'get_audit_logs': {
        const limit = args.limit as number | undefined;
        const limitVal = Math.min(limit || 50, 100);
        const logs = await db.auditLog.findMany({
          where: { companyId },
          take: limitVal,
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: { firstName: true, lastName: true, email: true },
            },
          },
        });
        return logs.map((l) => ({
          id: l.id,
          action: l.action,
          entity: l.entity,
          entityId: l.entityId,
          details: l.details,
          user: l.user ? `${l.user.firstName} ${l.user.lastName} (${l.user.email})` : 'Sistema',
          createdAt: l.createdAt.toISOString(),
        }));
      }

      case 'save_system_memory': {
        const title = args.title as string;
        const content = args.content as string;
        const type = args.type as string;
        const keywords = (args.keywords ?? []) as string[];
        const cleanKeywordsList = keywords.map((k: string) => k.toLowerCase().trim());
        const cleanKeywordsCsv = cleanKeywordsList.join(',');

        // Deduplicación por título o palabras clave coincidentes
        const existing = await db.systemMemory.findFirst({
          where: {
            companyId,
            type,
            OR: [
              { title: { contains: title } },
              { keywords: { contains: cleanKeywordsList[0] || '___' } },
            ],
          },
        });

        let memory;
        let action;

        if (existing) {
          // Unir palabras clave únicas
          const oldKeys = existing.keywords.split(',');
          const mergedKeys = [...new Set([...oldKeys, ...cleanKeywordsList])].join(',');
          memory = await db.systemMemory.update({
            where: { id: existing.id },
            data: {
              content,
              keywords: mergedKeys,
              importance: Math.min(10, existing.importance + 1), // Refuerzo de importancia
              updatedAt: new Date(),
            },
          });
          action = 'SYSTEM_MEMORY_UPDATED';
        } else {
          memory = await db.systemMemory.create({
            data: {
              companyId,
              title,
              content,
              type,
              keywords: cleanKeywordsCsv,
              importance: 5,
            },
          });
          action = 'SYSTEM_MEMORY_CREATED';
        }

        // Registro en log de auditoría del sistema
        if (userId) {
          try {
            await createAuditLogWithRetry({
              companyId,
              userId,
              action,
              entity: 'SystemMemory',
              entityId: memory.id,
              details: JSON.stringify({ title, type, keywords: cleanKeywordsCsv }),
            });
          } catch (auditErr) {
            logger.error('Failed to write system memory audit log', { error: auditErr });
          }
        }

        return {
          success: true,
          message: existing
            ? `Memoria "${title}" actualizada y reforzada.`
            : `Memoria "${title}" guardada exitosamente.`,
        };
      }

      default:
        return { error: `Tool ${name} not found` };
    }
  } catch (error: unknown) {
    logger.error('Error executing tool', { tool: name, error });
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

// ─── POST /api/ai-assistant ────────────────────────────────────────
export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const { userId } = getRequestContext()!;

    try {
      const raw: unknown = await request.json();
      const parsed = RequestBodySchema.safeParse(raw);
      if (!parsed.success) {
        return NextResponse.json(
          { error: parsed.error.issues?.[0]?.message || 'Invalid request format' },
          { status: 400 },
        );
      }
      const { message, mode, companyId: bodyCompanyId, history, isWarmup } = parsed.data;

      if (isWarmup) {
        try {
          logger.info('Starting LLM warmup call');
          await callAI([{ role: 'user', content: 'Hola' }]);
          logger.info('AI warmup call completed successfully');
          return NextResponse.json({ reply: 'Warmup completed successfully' });
        } catch (err: unknown) {
          logger.error('Failed to warm up LLM connection', {
            error: err instanceof Error ? err.message : String(err),
          });
          return NextResponse.json({ error: 'Warmup failed' }, { status: 502 });
        }
      }

      let companyId = bodyCompanyId;
      if (!companyId) {
        const membership = await db.companyMember.findFirst({
          where: { userId },
          select: { companyId: true },
        });
        if (membership) {
          companyId = membership.companyId;
        }
      } else {
        const membership = await db.companyMember.findFirst({
          where: { userId, companyId },
        });
        if (!membership) {
          return NextResponse.json({ error: 'Forbidden: No membership found' }, { status: 403 });
        }
      }

      if (!companyId) {
        return NextResponse.json(
          { error: 'No company context available. Select a company first.' },
          { status: 400 },
        );
      }

      if (mode === 'create-rule') {
        return await handleCreateRule(message, history, companyId, userId);
      }
      return await handleChat(message, history, companyId, userId);
    } catch (error) {
      logger.error('AI assistant error', { error });
      const code = (error as Error & { code?: string }).code;
      if (code === 'AI_NOT_CONFIGURED') {
        return NextResponse.json(
          { error: 'AI not configured. Set it up in Settings → AI.', code: 'AI_NOT_CONFIGURED' },
          { status: 500 },
        );
      }
      return NextResponse.json(
        { error: 'AI service did not respond. Please try again.', code: 'AI_REQUEST_FAILED' },
        { status: 500 },
      );
    }
  },
  { requireMembership: false },
);

// Helper to call the LLM via fetch with timeout, tool definition and error handling
async function callAI(
  messages: AiChatMessage[],
  tools?: Array<{
    type: string;
    function: { name: string; description: string; parameters: Record<string, unknown> };
  }>,
  requireJson?: boolean,
) {
  const apiKey = process.env.AI_API_KEY;
  const baseUrl = process.env.AI_BASE_URL || AI_CONFIG.BASE_URL;
  let configuredModel = process.env.AI_MODEL;
  if (!configuredModel || configuredModel === AI_CONFIG.LEGACY_MODEL) {
    configuredModel = AI_CONFIG.DEFAULT_MODEL;
  }
  if (!apiKey || !baseUrl || !configuredModel) {
    const err = new Error('AI not configured. Set it up in Settings → AI.') as Error & { code?: string };
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }

  // Crear la lista de modelos a intentar en orden de prioridad
  const modelsToTry: string[] = [];

  // Si el modelo configurado es "openrouter/free", priorizamos modelos estables e instructivos de antemano
  if (configuredModel === 'openrouter/free') {
    modelsToTry.push('openrouter/free');
    modelsToTry.push('google/gemini-2.5-flash:free');
    modelsToTry.push('qwen/qwen-2.5-72b-instruct:free');
  } else {
    modelsToTry.push(configuredModel);
    if (configuredModel.includes(':free')) {
      const fallbacks = [
        'google/gemini-2.5-flash:free',
        'qwen/qwen-2.5-72b-instruct:free',
        'openrouter/free',
      ];
      for (const f of fallbacks) {
        if (!modelsToTry.includes(f)) {
          modelsToTry.push(f);
        }
      }
    }
  }

  let lastError: Error | null = null;

  for (let m = 0; m < modelsToTry.length; m++) {
    const currentModel = modelsToTry[m];
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000); // 12s timeout por intento

    try {
      const body: Record<string, unknown> = { model: currentModel, messages };
      if (tools && tools.length > 0) {
        body.tools = tools;
      }

      logger.info('Trying AI model', { model: currentModel });

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.status === 429) {
        logger.warn('Model rate limited (429), trying next model', { model: currentModel });
        lastError = new Error(`AI service error 429 for model ${currentModel}`);
        continue;
      }

      if (!response.ok) {
        const txt = await response.text();
        logger.error('AI service error', {
          status: response.status,
          model: currentModel,
          responseText: txt,
        });
        lastError = new Error(`AI service error ${response.status}: ${txt}`);
        continue;
      }

      const data = await response.json();
      const parsed = AIResponseSchema.safeParse(data);
      if (!parsed.success) {
        logger.error('AI response parse error', { zodError: parsed.error });
        throw new Error('Invalid AI response format');
      }

      const content = parsed.data.choices?.[0]?.message?.content ?? '';

      // Si requerimos JSON estructurado (por ej. para reglas), validamos que no devuelva logs de seguridad o texto plano vacío
      if (requireJson) {
        const hasJson = content.includes('{') && content.includes('}');
        const isSafetyLog =
          content.includes('User Safety:') || content.includes('Response Safety:');
        if (!hasJson || isSafetyLog) {
          throw new Error(
            `El modelo ${currentModel} devolvió texto plano o log de seguridad en lugar de JSON: "${content.substring(0, 100)}"`,
          );
        }
      }

      logger.info('AI response successful', { model: currentModel });
      return parsed.data;
    } catch (err: unknown) {
      clearTimeout(timeout);
      logger.error('AI model exception', {
        model: currentModel,
        error: err instanceof Error ? err.message : String(err),
      });
      lastError = err instanceof Error ? err : new Error(String(err));
      continue;
    }
  }

  throw lastError || new Error('Todos los modelos de IA fallaron.');
}

// Helper to retrieve matching memories from SQLite using keywords and scoring
async function retrieveMemories(
  message: string,
  companyId: string,
  locale: 'es' | 'en' = 'es',
): Promise<string> {
  let config: { maxMemoriesToInject?: number; [key: string]: unknown };
  try {
    const { readJsonConfig } = await import('@/lib/config-loader');
    config = await readJsonConfig<{ maxMemoriesToInject?: number }>('memory-config.json');
  } catch {
    return '';
  }

  try {
    const keywords = extractKeywords(message, locale);
    if (keywords.length === 0) return '';

    // Expand search keywords to include singular forms for words ending with 's'
    const searchKeywords = [...keywords];
    for (const k of keywords) {
      if (k.endsWith('s') && k.length > 3) {
        const singular = k.slice(0, -1);
        if (!searchKeywords.includes(singular)) {
          searchKeywords.push(singular);
        }
      }
    }

    // Búsqueda eficiente usando cláusulas contains/OR en Prisma para SQLite
    const OR = searchKeywords.map((k) => ({
      keywords: {
        contains: k,
      },
    }));

    const memories = await db.systemMemory.findMany({
      where: {
        companyId,
        OR,
      },
      take: config.maxMemoriesToInject || 5,
      orderBy: [{ importance: 'desc' }, { updatedAt: 'desc' }],
    });

    if (memories.length === 0) return '';

    // Actualizar lastAccessedAt y accessCount de manera asíncrona sin bloquear la respuesta principal
    db.systemMemory
      .updateMany({
        where: {
          id: {
            in: memories.map((m) => m.id),
          },
        },
        data: {
          lastAccessedAt: new Date(),
          accessCount: {
            increment: 1,
          },
        },
      })
      .catch((err) => logger.error('Memory access update error', { error: err }));

    const formatted = memories
      .map((m) => `- [${m.type.toUpperCase()}] ${m.title}: ${m.content}`)
      .join('\n');

    return `\n## Contexto Histórico del Sistema (Hechos/Preferencias Recordadas):\n${formatted}\n`;
  } catch (err) {
    logger.error('Retrieve memories error', { error: err });
    return '';
  }
}

// ─── Chat Mode ─────────────────────────────────────────────────────
async function handleChat(
  message: string,
  history?: AiChatMessage[],
  companyId?: string,
  userId?: string,
) {
  const guardrail = checkPromptInjection(message);
  if (!guardrail.passed) {
    return NextResponse.json({
      reply: 'Lo siento, no puedo procesar ese mensaje. Contenido no permitido detectado.',
    });
  }

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
- Answer real-time specific questions about the company's accounts, rules, bank transactions, entities (partners/socios, clients, vendors), journal entries, fiscal periods, reconciliation periods, bank statements, users, and audit logs using the available tools.

ASSISTANT ACTIONS & DEEP LINKING:
- Cuando sugieras crear una cuenta de banco específica en el Plan de Cuentas (por ejemplo, como subcuenta de Cash & Cash Equivalents 1010), al final de tu respuesta de sugerencia debes agregar de manera exacta e invariable la etiqueta: [Te ayudo a crearla](action:create-account)
- No agregues explicaciones adicionales después de esa etiqueta.
- Cuando menciones una cuenta contable específica o sus saldos/gastos, incluye un enlace markdown directo usando su código exacto. Ejemplo: [Cuenta 3040-01](/accounts?code=3040-01) o [Ver detalles de la cuenta](/accounts?code=3040).
- Obtén el código correcto de la cuenta consultando tus herramientas ('get_gl_accounts', 'get_entity_contexts', etc.), NUNCA lo inventes.
- Cuando expliques cómo realizar un proceso en el sistema, incluye un enlace directo a la pantalla correspondiente. Ejemplos: 
  - Crear o administrar usuarios -> [Ir a Usuarios](/admin/users)
  - Cargar transacciones/importar -> [Ir a Importación](/import)
  - Reglas bancarias -> [Ir a Reglas](/bank-rules)
  - Conciliación -> [Ir a Conciliación](/reconciliation)
  - Plan de cuentas -> [Ir a Plan de Cuentas](/accounts)
- Cuando el cálculo sea extenso o dependa de ver muchas transacciones individuales, provee el monto total y sugiere al usuario ver el detalle en la pantalla con el enlace correspondiente.

DATABASE ACCESS GUIDELINES:
- When the user asks about system-specific counts, balances, rules, accounts, transactions, entities, journal entries, fiscal/reconciliation periods, statements, users, or audit logs, ALWAYS call the appropriate tool.
- IMPORTANT: DO NOT say "I will query the database now" or "Voy a solicitar los datos al motor" and stop. If you need data, CALL the tool IMMEDIATELY in the same response. Do not ask for permission to use tools. Do not output text describing your future tool calls. Just call them directly.
- Do NOT guess or hallucinate any numbers or data; use the tools to get exact and true information.
- Format all numeric values (currency balances, transaction counts) clearly and beautifully (e.g. $1,250.00).
- If no companyId or active company is linked, explain that you need a selected company to view details.

YOUR STYLE:
- Friendly but professional
- Use accounting terminology correctly
- Provide actionable advice
- When unsure, suggest consulting their CPA or tax advisor
- Format responses with clear structure when needed (bullet points, numbered lists)
- Keep responses concise but thorough.`;

  const isEnglish =
    /hello|hi|rule|amount|debit|credit|account|company|settings|reconcile|verify|archive|onboard/i.test(
      message,
    );
  const locale = isEnglish ? 'en' : 'es';
  const memoriesContext = companyId ? await retrieveMemories(message, companyId, locale) : '';
  const finalSystemPrompt = systemPrompt + memoriesContext;

  const messages: AiChatMessage[] = [{ role: 'system', content: finalSystemPrompt }];

  if (history && Array.isArray(history)) {
    for (const h of history) {
      if (h.role && h.content) {
        messages.push({ role: h.role, content: h.content });
      }
    }
  }

  const lastHistoryMsg = history && history.length > 0 ? history[history.length - 1] : null;
  if (!lastHistoryMsg || lastHistoryMsg.content !== message || lastHistoryMsg.role !== 'user') {
    messages.push({ role: 'user', content: message });
  }

  for (let i = 0; i < 5; i++) {
    const response = await callAI(messages, TOOLS);
    const choice = response.choices?.[0];
    if (!choice) {
      throw new Error('No choice in AI response');
    }

     
    const aiMessage = choice.message as any;
    messages.push(aiMessage);

    if (aiMessage.tool_calls && aiMessage.tool_calls.length > 0) {
      if (!companyId) {
        return NextResponse.json({
          reply:
            'Lo siento, para consultar los datos del sistema necesitas tener una empresa activa seleccionada.',
        });
      }

      for (const toolCall of aiMessage.tool_calls) {
        let args = {};
        try {
          args =
            typeof toolCall.function.arguments === 'string'
              ? JSON.parse(toolCall.function.arguments)
              : toolCall.function.arguments;
        } catch (e) {
          logger.error('Failed to parse tool arguments', { error: e });
        }

        const result = await executeTool(toolCall.function.name, args, companyId, userId);
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify(result),
        });
      }
      continue;
    }

    const reply =
      aiMessage.content ?? 'Lo siento, no pude procesar tu solicitud. Intenta de nuevo.';
    return NextResponse.json({ reply });
  }

  throw new Error('Too many tool iterations');
}

// ─── Create Rule Mode ──────────────────────────────────────────────
async function handleCreateRule(
  message: string,
  history?: AiChatMessage[],
  companyId?: string,
  userId?: string,
) {
  const guardrail = checkPromptInjection(message);
  if (!guardrail.passed) {
    return NextResponse.json({
      reply: 'Lo siento, no puedo procesar ese mensaje. Contenido no permitido detectado.',
    });
  }

  // 1. Obtener el plan de cuentas de la empresa para inyectarlo en el prompt del sistema
  let glAccountsList = '';
  if (companyId) {
    try {
      const glAccounts = await db.glAccount.findMany({
        where: { companyId, isActive: true },
        select: { code: true, name: true, accountType: true },
        orderBy: { code: 'asc' },
      });
      glAccountsList = glAccounts
        .map((a) => `- [${a.code}] ${a.name} (${a.accountType})`)
        .join('\n');
    } catch (e) {
      logger.error('Error fetching GL accounts for rule builder prompt', { error: e });
    }
  }

  const systemPrompt = `You are a bank categorization rule builder for the AccountExpress platform.
Your task is to parse user descriptions of rules (or conversations about rules) and respond with a structured JSON object.

We support advanced V2 rules with multiple conditions (using JSON logic) and bifurcated account matching (different accounts for incoming vs outgoing transactions).

AVAILABLE GL ACCOUNTS IN THE PLAN OF ACCOUNTS:
${glAccountsList || 'No plan of accounts loaded.'}

JSON STRUCTURE TO RETURN:
{
  "name": "string (descriptive name for the rule)",
  "isComplete": true/false, // set to true if we have all needed information (conditions, and accounts to assign). Set to false if we need to ask the user a clarification question.
  "clarificationQuestion": "string (friendly question in Spanish if isComplete is false, asking for the missing info and suggesting matching accounts)",
  "conditions": [
    {
      "field": "description" | "amount",
      "operator": "contains" | "starts_with" | "ends_with" | "equals" | "amount_greater" | "amount_less",
      "value": "string | number"
    }
  ],
  "debitGlAccountName": "string (account name from the available list to assign for debits/withdrawals/outflows. Optional if isComplete is false)",
  "creditGlAccountName": "string (account name from the available list to assign for credits/deposits/inflows. Optional if isComplete is false)",
  "glAccountName": "string (account name to assign for both directions if they are the same. Optional if isComplete is false)",
  "transactionDirection": "any" | "debit" | "credit",
  "priority": number (integer between 0 and 20, default 10)
}

RULES:
1. If the user does not specify a target GL account name, search the Plan of Accounts listed above for potential matches. Set "isComplete": false, and ask a clarification question in "clarificationQuestion" (in Spanish) suggesting 2-3 logical matches from the available list.
2. Pay close attention to double quotes (") in the user input. Words or phrases wrapped in double quotes represent the precise values for conditions (e.g. description matches, name matches, etc.). Always extract these exact quoted strings as the "value" in the conditions array.
3. BIFURCATED RULES (debit vs credit): If the user specifies different accounts for positive/deposits vs negative/withdrawals (e.g. "si el importe es positivo se considera aporte... y si es negativo préstamo..."), DO NOT create conditions checking the amount (such as greater than or less than 0). Instead, simply create the description conditions (e.g. description contains the name) and assign the different accounts to "debitGlAccountName" (for negative/withdrawals) and "creditGlAccountName" (for positive/deposits).
4. ALLOWED OPERATORS: You can only use the following exact operator strings: 'contains', 'starts_with', 'ends_with', 'equals', 'amount_greater', 'amount_less'. Do NOT use 'greater_than', 'less_than', or any other value.
5. STRICT JSON VALIDITY: Your response must be 100% valid JSON. Do NOT duplicate keys (do NOT output multiple separate "conditions" keys in the same object). Do NOT output invalid syntax like "value": "A" or "B". If a field has multiple alternatives, select the most important one or create separate conditions inside the array.
6. You MUST respond ONLY with the JSON object. Do not include markdown codeblocks (no \`\`\`), no extra text outside the JSON.
7. If the user is responding to your previous clarification question, analyze the conversational history to resolve the missing fields.

EXAMPLE OF INCOMPLETE RULE RESPONSE:
{"name":"Cliente Ejemplo Rule","isComplete":false,"clarificationQuestion":"Veo que querés crear una regla para Cliente Ejemplo, pero no especificaste la cuenta contable. ¿Deberíamos registrar las transacciones en una cuenta de ingreso o de gasto?","conditions":[{"field":"description","operator":"contains","value":"Cliente Ejemplo"}],"transactionDirection":"any","priority":10}

EXAMPLE OF COMPLETED BIFURCATED RULE RESPONSE:
{"name":"Cliente Ejemplo - Zelle","isComplete":true,"conditions":[{"field":"description","operator":"contains","value":"Cliente Ejemplo"},{"field":"description","operator":"contains","value":"Zelle"}],"debitGlAccountName":"Cuenta de Gasto","creditGlAccountName":"Cuenta de Ingreso","transactionDirection":"any","priority":10}`;

  const isEnglish =
    /hello|hi|rule|amount|debit|credit|account|company|settings|reconcile|verify|archive|onboard/i.test(
      message,
    );
  const locale = isEnglish ? 'en' : 'es';
  const memoriesContext = companyId ? await retrieveMemories(message, companyId, locale) : '';
  const finalSystemPrompt = systemPrompt + memoriesContext;

  // Construir historial de mensajes para callAI
  const apiMessages: AiChatMessage[] = [{ role: 'system', content: finalSystemPrompt }];

  if (history && Array.isArray(history)) {
    for (const h of history) {
      if (h.role && h.content) {
        apiMessages.push({ role: h.role, content: h.content });
      }
    }
  }

  // Añadir el mensaje final del usuario si no está en el history o para asegurar
  const lastHistoryMsg = history && history.length > 0 ? history[history.length - 1] : null;
  if (!lastHistoryMsg || lastHistoryMsg.content !== message || lastHistoryMsg.role !== 'user') {
    apiMessages.push({ role: 'user', content: message });
  }

  let aiData;
  try {
    aiData = await callAI(apiMessages, undefined, true);
  } catch (aiError: unknown) {
    logger.error('AI call failed in create-rule', {
      error: aiError instanceof Error ? aiError.message : String(aiError),
    });
    return NextResponse.json({
      reply:
        '⚠️ El modelo de IA no respondió a tiempo. Por favor, intenta de nuevo en unos segundos.',
      isComplete: false,
    });
  }

  const rawReply = aiData.choices?.[0]?.message?.content ?? '';

  let parsedRule: ParsedRuleFromAI | null = null;
  let reply = '';
  let isComplete = false;
  let clarificationQuestion = '';

  try {
    // Limpieza de JSON flexible (por si la IA pone markdown o texto extra)
    const jsonMatch = rawReply.match(/\{[\s\S]*\}/) ?? null;
    const jsonStr = jsonMatch ? jsonMatch[0].trim() : rawReply.trim();
    const parsedJson = JSON.parse(jsonStr);

    isComplete = parsedJson.isComplete === true;
    clarificationQuestion = parsedJson.clarificationQuestion || '';

    // Validar esquema Zod tolerando coerción de prioridad a número
    const ruleResult = ParsedRuleV2Schema.safeParse(parsedJson);

    if (ruleResult.success) {
      parsedRule = ruleResult.data;
      if (isComplete) {
        reply = '✅ Regla analizada exitosamente. Revisa los campos y guarda la regla.';
      } else {
        reply = clarificationQuestion || '⚠️ Necesito más detalles para poder crear la regla.';
      }
    } else {
      isComplete = false;
      logger.warn('Zod validation failed for parsed rule', { zodError: ruleResult.error });
      // If we extracted a clarification question before Zod failed, use it
      if (clarificationQuestion) {
        reply = clarificationQuestion;
      } else {
        reply =
          '⚠️ No pude interpretar la respuesta. ¿Podrías reformular tu solicitud con más detalle?';
      }
    }
  } catch (e: unknown) {
    logger.error('Error parsing rule JSON', { error: e, rawReply });
    // If the AI returned plain text instead of JSON, use it as the reply
    if (rawReply && rawReply.length > 10 && !rawReply.startsWith('{')) {
      reply = rawReply;
    } else {
      reply = '⚠️ Error al analizar la regla. Por favor, describe la regla con más detalle.';
    }
  }

  const ruleWithConfidence = parsedRule
    ? {
        ...parsedRule,
        confidence: parsedRule.confidence ?? 0.85,
        confidenceLabel: parsedRule.confidenceLabel ?? 'high',
      }
    : undefined;

  return NextResponse.json({
    reply,
    isComplete,
    rawJson: rawReply,
    ...(ruleWithConfidence ? { parsedRule: ruleWithConfidence } : {}),
  });
}
