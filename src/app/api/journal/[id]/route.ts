import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { assertActiveFiscalPeriod } from '@/lib/fiscal-period-guard';
import { JournalEntryService } from '@/lib/services/journal-entry.service';
import { createAuditLogWithRetry } from '@/lib/audit';

// ─── GET /api/journal/[id] ──────────────────────────────────────────
// Get a single journal entry with all lines and GL account info.
export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    const { id } = await context.params;

    const entry = await db.journalEntry.findUnique({
      where: { id },
      include: {
        lines: {
          include: {
            glAccount: {
              select: {
                id: true,
                code: true,
                name: true,
                accountType: true,
                normalBalance: true,
              },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
    });

    if (!entry) {
      return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    }

    // Verify user has access
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId: entry.companyId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    return NextResponse.json({
      ...entry,
      date: entry.date.toISOString(),
      createdAt: entry.createdAt.toISOString(),
      updatedAt: entry.updatedAt.toISOString(),
    });
  },
  { requireMembership: false },
);

// ─── PUT /api/journal/[id] ──────────────────────────────────────────
// Update a draft journal entry. Posted/void entries cannot be modified.
export const PUT = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    const { id } = await context.params;

    // Verify entry exists and is a draft
    const existing = await db.journalEntry.findUnique({
      where: { id },
      include: { lines: true },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    }

    if (existing.status !== 'draft') {
      return NextResponse.json({ error: 'Only draft entries can be modified' }, { status: 400 });
    }

    // Verify access
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId: existing.companyId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { date, description, reference, lines } = body;

    // Build update data
    const updateData: Record<string, unknown> = {};
    if (date !== undefined) updateData.date = new Date(date);
    if (description !== undefined) updateData.description = description;
    if (reference !== undefined) updateData.reference = reference || null;

    // If lines are provided, validate them
    if (lines !== undefined) {
      if (!Array.isArray(lines) || lines.length < 2) {
        return NextResponse.json(
          { error: 'At least 2 journal lines are required' },
          { status: 400 },
        );
      }

      for (const line of lines) {
        if (!line.glAccountId) {
          return NextResponse.json({ error: 'Each line must have a glAccountId' }, { status: 400 });
        }
        if (typeof line.debit !== 'number' || typeof line.credit !== 'number') {
          return NextResponse.json(
            { error: 'Each line must have debit and credit amounts' },
            { status: 400 },
          );
        }
        if (line.debit < 0 || line.credit < 0) {
          return NextResponse.json(
            { error: 'Debit and credit amounts must be non-negative' },
            { status: 400 },
          );
        }
      }

      const totalDebits = lines.reduce((sum: number, l: { debit: number }) => sum + l.debit, 0);
      const totalCredits = lines.reduce((sum: number, l: { credit: number }) => sum + l.credit, 0);

      if (Math.abs(totalDebits - totalCredits) > 0.005) {
        return NextResponse.json(
          {
            error: `Entry must balance. Total debits (${totalDebits.toFixed(2)}) must equal total credits (${totalCredits.toFixed(2)})`,
          },
          { status: 400 },
        );
      }

      // Verify GL accounts
      const accountIds = lines.map((l: { glAccountId: string }) => l.glAccountId);
      const accounts = await db.glAccount.findMany({
        where: { id: { in: accountIds }, companyId: existing.companyId },
      });
      if (accounts.length !== new Set(accountIds).size) {
        return NextResponse.json(
          { error: 'One or more GL accounts not found or do not belong to this company' },
          { status: 400 },
        );
      }
    }

    // Update in a transaction — atomic: deleteMany + create inside a single update
    const updated = await db.$transaction(async (tx) => {
      const entry = await tx.journalEntry.update({
        where: { id },
        data: {
          ...updateData,
          ...(lines !== undefined && {
            lines: {
              deleteMany: {},
              create: lines.map(
                (l: {
                  glAccountId: string;
                  description?: string;
                  debit: number;
                  credit: number;
                }) => ({
                  glAccountId: l.glAccountId,
                  description: l.description || null,
                  debit: l.debit,
                  credit: l.credit,
                }),
              ),
            },
          }),
        },
        include: {
          lines: {
            include: {
              glAccount: {
                select: {
                  id: true,
                  code: true,
                  name: true,
                  accountType: true,
                  normalBalance: true,
                },
              },
            },
          },
        },
      });

      return entry;
    });

    return NextResponse.json({
      ...updated,
      date: updated.date.toISOString(),
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    });
  },
  { requireMembership: false },
);

// ─── POST /api/journal/[id] ─────────────────────────────────────────
// Actions: post | void
// Body: { action: 'post' | 'void' }
export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    const { id } = await context.params;

    const entry = await db.journalEntry.findUnique({
      where: { id },
      include: { lines: true },
    });

    if (!entry) {
      return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    }

    // Verify access
    const membership = await db.companyMember.findUnique({
      where: { userId_companyId: { userId, companyId: entry.companyId } },
    });
    if (!membership) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const { action } = body;

    const glAccountIds = [...new Set(entry.lines.map((l) => l.glAccountId))];

    if (action === 'post') {
      if (entry.status !== 'draft') {
        return NextResponse.json({ error: 'Only draft entries can be posted' }, { status: 400 });
      }

      await assertActiveFiscalPeriod(entry.companyId, entry.date);

      const updated = await db.$transaction(async (tx) => {
        const result = await tx.journalEntry.update({
          where: { id },
          data: { status: 'posted' },
          include: {
            lines: {
              include: {
                glAccount: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    accountType: true,
                    normalBalance: true,
                  },
                },
              },
            },
          },
        });

        await createAuditLogWithRetry(
          { companyId: entry.companyId, userId, action: 'post', entity: 'journalEntry', entityId: id },
          tx as any,
        );

        for (const glAccountId of glAccountIds) {
          await JournalEntryService.recalculateBalance(tx as any, glAccountId);
        }

        return result;
      });

      return NextResponse.json({
        ...updated,
        date: updated.date.toISOString(),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      });
    }

    if (action === 'void') {
      if (entry.status !== 'posted') {
        return NextResponse.json({ error: 'Only posted entries can be voided' }, { status: 400 });
      }

      await assertActiveFiscalPeriod(entry.companyId, entry.date);

      const updated = await db.$transaction(async (tx) => {
        const result = await tx.journalEntry.update({
          where: { id },
          data: { status: 'void' },
          include: {
            lines: {
              include: {
                glAccount: {
                  select: {
                    id: true,
                    code: true,
                    name: true,
                    accountType: true,
                    normalBalance: true,
                  },
                },
              },
            },
          },
        });

        await createAuditLogWithRetry(
          { companyId: entry.companyId, userId, action: 'void', entity: 'journalEntry', entityId: id },
          tx as any,
        );

        for (const glAccountId of glAccountIds) {
          await JournalEntryService.recalculateBalance(tx as any, glAccountId);
        }

        return result;
      });

      return NextResponse.json({
        ...updated,
        date: updated.date.toISOString(),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      });
    }

    return NextResponse.json({ error: 'Invalid action. Use "post" or "void".' }, { status: 400 });
  },
  { requireMembership: false },
);
