import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getSessionUserId } from '@/lib/sessions';

// ─── GET /api/journal/[id] ──────────────────────────────────────────
// Get a single journal entry with all lines and GL account info.
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

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
}

// ─── PUT /api/journal/[id] ──────────────────────────────────────────
// Update a draft journal entry. Posted/void entries cannot be modified.
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
    // Verify entry exists and is a draft
    const existing = await db.journalEntry.findUnique({
      where: { id },
      include: { lines: true },
    });

    if (!existing) {
      return NextResponse.json({ error: 'Entry not found' }, { status: 404 });
    }

    if (existing.status !== 'draft') {
      return NextResponse.json(
        { error: 'Only draft entries can be modified' },
        { status: 400 }
      );
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
          { status: 400 }
        );
      }

      for (const line of lines) {
        if (!line.glAccountId) {
          return NextResponse.json(
            { error: 'Each line must have a glAccountId' },
            { status: 400 }
          );
        }
        if (typeof line.debit !== 'number' || typeof line.credit !== 'number') {
          return NextResponse.json(
            { error: 'Each line must have debit and credit amounts' },
            { status: 400 }
          );
        }
        if (line.debit < 0 || line.credit < 0) {
          return NextResponse.json(
            { error: 'Debit and credit amounts must be non-negative' },
            { status: 400 }
          );
        }
      }

      const totalDebits = lines.reduce((sum: number, l: { debit: number }) => sum + l.debit, 0);
      const totalCredits = lines.reduce((sum: number, l: { credit: number }) => sum + l.credit, 0);

      if (Math.abs(totalDebits - totalCredits) > 0.005) {
        return NextResponse.json(
          { error: `Entry must balance. Total debits (${totalDebits.toFixed(2)}) must equal total credits (${totalCredits.toFixed(2)})` },
          { status: 400 }
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
          { status: 400 }
        );
      }
    }

    // Update in a transaction
    const updated = await db.$transaction(async (tx) => {
      // Delete existing lines
      await tx.journalLine.deleteMany({ where: { entryId: id } });

      // Update the entry
      const entry = await tx.journalEntry.update({
        where: { id },
        data: {
          ...updateData,
          ...(lines !== undefined && {
            lines: {
              create: lines.map((l: { glAccountId: string; description?: string; debit: number; credit: number }) => ({
                glAccountId: l.glAccountId,
                description: l.description || null,
                debit: l.debit,
                credit: l.credit,
              })),
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
  } catch (error) {
    console.error('[JOURNAL UPDATE ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// ─── POST /api/journal/[id] ─────────────────────────────────────────
// Actions: post | void
// Body: { action: 'post' | 'void' }
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = getSessionUserId(request);
  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;

  try {
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

    if (action === 'post') {
      if (entry.status !== 'draft') {
        return NextResponse.json(
          { error: 'Only draft entries can be posted' },
          { status: 400 }
        );
      }

      const updated = await db.journalEntry.update({
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

      return NextResponse.json({
        ...updated,
        date: updated.date.toISOString(),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      });
    }

    if (action === 'void') {
      if (entry.status !== 'posted') {
        return NextResponse.json(
          { error: 'Only posted entries can be voided' },
          { status: 400 }
        );
      }

      const updated = await db.journalEntry.update({
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

      return NextResponse.json({
        ...updated,
        date: updated.date.toISOString(),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      });
    }

    return NextResponse.json(
      { error: 'Invalid action. Use "post" or "void".' },
      { status: 400 }
    );
  } catch (error) {
    console.error('[JOURNAL ACTION ERROR]', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
