import type { Prisma } from '@prisma/client';
import { computeEntryHashV2, recomputeLegacyHash } from './journal-hash';

/**
 * JH2 — The single transactional primitive that appends an entry to the
 * per-company journal hash chain.
 *
 * Operating contract (JH.0/JH.1/JH.1A):
 *  - must be called with the SAME `tx` that created/POSTed the entry
 *    (entry + lines + append + chain head share one transactional boundary);
 *  - no COMMIT of its own: rollback stays under the caller's transaction;
 *  - chain head serialization via
 *      INSERT ... ON CONFLICT (companyId) DO UPDATE ... RETURNING
 *    so two same-company concurrent appends cannot read the same lastHash;
 *  - ROOT V2 only when the company provably has zero pre-existing hashes.
 */

export class JournalChainError extends Error {
  code: string;

  constructor(code: string, message?: string) {
    super(message ? `[${code}] ${message}` : `[${code}]`);
    this.code = code;
    this.name = 'JournalChainError';
  }
}

type RawPair = { lastHash: string | null; lastEntryId: string | null };

type ChainTx = Pick<
  Prisma.TransactionClient,
  'journalEntry' | '$queryRaw' | '$executeRawUnsafe'
>;

/**
 * Append `entryId` to the companyId chain. The full body runs inside `tx`.
 * REJECTED when entry not found / cross-company, not posted, missing lines,
 * already hashed, when a legacy chain cannot be certified, or when the head
 * row contradicts a v2 chain (integrity barrier, fail closed).
 */
export async function appendEntryToJournalChain(
  tx: ChainTx,
  params: { companyId: string; entryId: string },
): Promise<void> {
  const { companyId, entryId } = params;

  const entry = await tx.journalEntry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      companyId: true,
      date: true,
      description: true,
      reference: true,
      status: true,
      hash: true,
      previousHash: true,
      hashVersion: true,
      lines: {
        select: { glAccountId: true, debit: true, credit: true, description: true },
      },
    },
  });

  // (2) entry + lines loaded INSIDE the caller transaction.
  if (!entry) throw new JournalChainError('CHAIN_ENTRY_NOT_FOUND');
  if (entry.companyId !== companyId) {
    throw new JournalChainError('CHAIN_COMPANY_MISMATCH');
  }
  if (entry.status !== 'posted') {
    throw new JournalChainError('CHAIN_NOT_POSTED');
  }
  if (entry.hash != null) {
    // (3) double append prevention; a v2 marker paired with a null hash is a
    // structural inconsistency — fail closed either way.
    throw new JournalChainError(
      entry.hashVersion === 'v2'
        ? 'CHAIN_ALREADY_HASHED'
        : 'CHAIN_STATE_INCONSISTENT',
    );
  }

  // (5)(6) derive/lock the per-company head INSIDE the same tx. The
  // ON CONFLICT DO UPDATE row-lock serializes same-company concurrent
  // appends (loser waits for commit and re-reads the committed tail), while
  // distinct companies lock distinct rows (independent chains).
  const headRows = await tx.$queryRaw<Array<{ lastHash: string | null; lastEntryId: string | null }>>`
    INSERT INTO "JournalChainHead" ("id", "companyId", "lastHash", "lastEntryId")
    VALUES (gen_random_uuid()::text, ${companyId}::text, NULL, NULL)
    ON CONFLICT ("companyId")
    DO UPDATE SET "lastHash" = "JournalChainHead"."lastHash", "lastEntryId" = "JournalChainHead"."lastEntryId"
    RETURNING "lastHash", "lastEntryId"`;

  const head = headRows[0];
  if (!head) throw new JournalChainError('CHAIN_HEAD_MISSING');

  if (head.lastHash == null) {
    // Head empty: ROOT V2 is allowed only when the company has NO pre-existing
    // hashes (fresh chain). Legacy rows (hash != null) make the legacy chain
    // the true tail: certify it or block (never invent a ROOT).
    const legacyRows = await tx.journalEntry.findMany({
      where: {
        companyId,
        OR: [{ status: 'posted' }, { status: 'void' }],
        hash: { not: null },
        hashVersion: null,
      },
      select: {
        id: true,
        companyId: true,
        date: true,
        description: true,
        reference: true,
        status: true,
        hash: true,
        previousHash: true,
        hashVersion: true,
        lines: {
          select: { glAccountId: true, debit: true, credit: true, description: true },
        },
      },
    });
    if (legacyRows.length > 0) {
      // Legacy chain exists without a head anchor: the derivation must BOTH
      // (a) certify every legacy member locally under V1 with its stored
      // previousHash and (b) prove exactly one ROOT with unambiguous links.
      const legacyTail = deriveLegacyTail(
        legacyRows as unknown as LegacyRow[],
      );
      if (legacyTail == null) {
        throw new JournalChainError('LEGACY_HASH_UNCERTIFIABLE');
      }
      await finishAppend(tx, companyId, entry, legacyTail.hash);
      return;
    }
    // F3 (JH2.15) — never open a fresh ROOT over an UNSEALED historical
    // member: a posted row without any hash means the company history was
    // written outside the chain; appending a fresh V2 root would permanently
    // split the ledger integrity state. Membership note: `void` rows without
    // hash are never-posted (pending_review→void) and are NOT members, so
    // they do not trigger this guard. The entry being appended right now is
    // still unsealed BY DEFINITION — always excluded.
    const unsealedHistorical = await tx.journalEntry.findFirst({
      where: { companyId, status: 'posted', hash: null, id: { not: entryId } },
    });
    if (unsealedHistorical) {
      throw new JournalChainError('CHAIN_UNSEALED_HISTORICAL_MEMBER');
    }
    // Zero prior hashes anywhere → clean ROOT.
    await finishAppend(tx, companyId, entry, null);
    return;
  }

  // (7) previousHash = head.lastHash. The head row IS the tail certificate:
  // append only proceeds when the tail row still matches exactly.
  if (head.lastEntryId == null) {
    throw new JournalChainError('CHAIN_HEAD_MISMATCH');
  }
  const tail = await tx.journalEntry.findUnique({
    where: { id: head.lastEntryId },
    select: {
      id: true,
      companyId: true,
      date: true,
      description: true,
      reference: true,
      status: true,
      hash: true,
      previousHash: true,
      hashVersion: true,
      lines: {
        select: { glAccountId: true, debit: true, credit: true, description: true },
      },
    },
  });
  if (!tail) throw new JournalChainError('CHAIN_TAIL_NOT_FOUND');
  if (tail.companyId !== companyId || tail.hash !== head.lastHash) {
    throw new JournalChainError('CHAIN_HEAD_MISMATCH');
  }
  // Legacy tail must be certified under its own contract before chaining a
  // new V2 onto it; verified locally as an integrity gate.
  if (tail.hashVersion !== 'v2' && tail.hash) {
    const expected = recomputeLegacyHash(tail);
    if (tail.hash !== expected) {
      throw new JournalChainError('LEGACY_HASH_UNCERTIFIABLE');
    }
  }

  await finishAppend(tx, companyId, entry, head.lastHash);
}

/**
 * Persist hash + previousHash + hashVersion='v2' on the entry and advance the
 * head to the new TAIL — all inside the caller's transaction.
 */
async function finishAppend(
  tx: ChainTx,
  companyId: string,
  entry: {
    id: string;
    date: Date;
    description: string;
    reference: string | null;
    lines: Array<{
      glAccountId: string;
      debit: number | string | { toNumber(): number };
      credit: number | string | { toNumber(): number };
      description: string | null;
    }>;
  },
  lastHash: string | null,
): Promise<void> {
  const previousHash = lastHash;
  const hash = computeEntryHashV2({
    id: entry.id,
    companyId,
    date: entry.date,
    description: entry.description,
    reference: entry.reference,
    previousHash,
    lines: entry.lines,
  });

  await tx.journalEntry.update({
    where: { id: entry.id },
    data: { hash, previousHash, hashVersion: 'v2' },
  });

  await tx.$executeRawUnsafe(
    `UPDATE "JournalChainHead" SET "lastHash" = $1, "lastEntryId" = $2 WHERE "companyId" = $3`,
    hash,
    entry.id,
    companyId,
  );
}

/**
 * Derive the legacy tail deterministically from stored links ONLY:
 *  - exactly one ROOT (previousHash null);
 *  - fork/cycle/checked links;
 *  - every member locally certifiable under V1 (recompute matches stored);
 *  - full reachability (no orphan/parallel chains).
 * Returns the TAIL row, or null when ANY property fails: the caller blocks
 * with LEGACY_HASH_UNCERTIFIABLE without touching a single legacy byte.
 */
function deriveLegacyTail(rows: LegacyRow[]): LegacyRow | null {
  const roots = rows.filter((r) => r.previousHash == null);
  if (rows.length === 0 || roots.length !== 1) return null;
  if (rows.some((r) => r.hash == null)) return null;

  // Local V1 certification with the declared link (deterministic).
  for (const r of rows) {
    const expected = recomputeLegacyHash(r);
    if (r.hash !== expected) return null;
  }

  const successor = new Map<string, string>();
  for (const r of rows) {
    if (r.previousHash == null) continue;
    if (successor.has(r.previousHash)) return null; // fork
    successor.set(r.previousHash, r.id);
  }

  const visited = new Set<string>([roots[0].id]);
  let cur = roots[0];
  while (true) {
    const nextHash = cur.hash ?? '';
    const nextId = successor.get(nextHash);
    if (nextId == null) break;
    const next = rows.find((r) => r.id === nextId);
    if (!next || visited.has(next.id)) return null; // cycle / missing
    visited.add(next.id);
    cur = next;
  }
  if (visited.size !== rows.length) return null; // orphan / parallel

  return cur;
}

interface LegacyRow {
  id: string;
  companyId: string;
  date: Date;
  description: string;
  reference: string | null;
  status: string;
  hash: string | null;
  previousHash: string | null;
  hashVersion: string | null;
  lines: Array<{
    glAccountId: string;
    debit: number | string | { toNumber(): number };
    credit: number | string | { toNumber(): number };
    description: string | null;
  }>;
}
