import { createHmac } from 'crypto';

/**
 * Cryptographic audit chain service.
 * Each posted JournalEntry and AuditLog is chained via HMAC-SHA-256.
 * Any tampering with the database breaks the chain and is detectable.
 */

/**
 * JH2.12: HMAC_SECRET is resolved LAZILY at the moment a cryptographic
 * operation actually needs it. Importing this module (including under
 * `next build` page-data collection with NODE_ENV=production) must NOT
 * throw. A production runtime call without HMAC_SECRET still fails fast.
 * No insecure fallback in production; no hardcoded secrets.
 */
export function getJournalHmacSecret(): string {
  const secret = process.env.HMAC_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('HMAC_SECRET environment variable is required in production');
    }
    return 'dev-secret-not-for-production';
  }
  return secret;
}

/**
 * Compute HMAC-SHA-256 hash for a journal entry, chaining with the previous entry's hash.
 */
export function computeEntryHash(payload: {
  id: string;
  companyId: string;
  date: string;
  description: string;
  reference: string | null;
  status: string;
  totalDebit: number;
  totalCredit: number;
  previousHash: string | null;
}): string {
  const data = [
    payload.id,
    payload.companyId,
    payload.date,
    payload.description,
    payload.reference ?? '',
    payload.status,
    payload.totalDebit.toFixed(2),
    payload.totalCredit.toFixed(2),
    payload.previousHash ?? '',
  ].join('|');

  return createHmac('sha256', getJournalHmacSecret()).update(data).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// JH2 — Versioned hash contract ("v2")
// ─────────────────────────────────────────────────────────────────────────────

/** Version prefix INSIDE the HMAC input — the hash itself is version-bound. */
export const JOURNAL_HASH_V2_PREFIX = 'JH:v2|';

export interface JournalHashLinePayload {
  glAccountId: string;
  /** number | Prisma.Decimal | string — normalized defensively to number */
  debit: number | string | { toNumber(): number };
  credit: number | string | { toNumber(): number };
  description?: string | null;
}

function lineCanonical(l: JournalHashLinePayload): string {
  const debit = toMoneyNumber(l.debit);
  const credit = toMoneyNumber(l.credit);
  const description = l.description ?? '';
  // F2 (JH2.15): every field is length-prefixed with its UTF-8 byte length
  // (hex, ':' separator) — boundaries are therefore unambiguous regardless of
  // any '|', ';', Unicode or newlines inside the content. Value-based only:
  // line physical order/index is not part of the hash (stable sort below).
  return (
    lenPrefixed(l.glAccountId) +
    lenPrefixed(debit.toFixed(2)) +
    lenPrefixed(credit.toFixed(2)) +
    lenPrefixed(description)
  );
}

/**
 * F2 (JH2.15) — injective field encoding: "utf8ByteLength(hex):bytes".
 * The reader knows exactly where each field ends, so delimiter characters
 * inside free text can never be confused with structure. Not an artisanal
 * escaping scheme: a deterministic structural encoding.
 */
function lenPrefixed(value: string): string {
  return `${Buffer.byteLength(value, 'utf8').toString(16)}:${value}`;
}

function toMoneyNumber(v: JournalHashLinePayload['debit']): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  return v.toNumber();
}

/**
 * V2: HMAC-SHA-256 over "JH:v2|" + pipe-joined protected fields, with ALL
 * lines canonicalized (stable lexicographic sort over the serialized lines).
 * Line order in the DB is irrelevant. `status` is NOT part of the payload:
 * the hash represents the accounting substance at the moment of POST.
 * Legacy-opaque tails chain via previousHash exactly like v2 tails.
 */
export function computeEntryHashV2(payload: {
  id: string;
  companyId: string;
  date: Date | string;
  description: string;
  reference: string | null;
  previousHash: string | null;
  lines: JournalHashLinePayload[];
}): string {
  const dateIso =
    payload.date instanceof Date
      ? payload.date.toISOString()
      : new Date(payload.date).toISOString();

  // F2 (JH2.15): length-prefixed line encoding; sorted on the serialized
  // bytes (line order independence retained); without any line-number position.
  const linesFrame = `${lenPrefixed(String(payload.lines.length))};` +
    payload.lines
      .map((l) => lineCanonical(l))
      .sort()
      .join(';');

  const data =
    JOURNAL_HASH_V2_PREFIX +
    [
      payload.id,
      payload.companyId,
      dateIso,
      payload.description,
      payload.reference ?? '',
      payload.previousHash ?? '',
      linesFrame,
    ]
      // Every field is length-prefixed: separators cannot be spoofed by
      // content ('|' inside descriptions is just data).
      .map(lenPrefixed)
      .join('|');

  return createHmac('sha256', getJournalHmacSecret()).update(data).digest('hex');
}

/**
 * Compute HMAC-SHA-256 hash for an audit log entry, chaining with the previous log's hash.
 */
export function computeAuditHash(payload: {
  id: string;
  companyId: string | null;
  userId: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  details: string | null;
  previousHash: string | null;
}): string {
  const data = [
    payload.id,
    payload.companyId ?? '',
    payload.userId ?? '',
    payload.action,
    payload.entity,
    payload.entityId ?? '',
    payload.details ?? '',
    payload.previousHash ?? '',
  ].join('|');

  return createHmac('sha256', getJournalHmacSecret()).update(data).digest('hex');
}

/**
 * Verify the integrity of the entire journal entry hash chain for a company.
 * Returns { valid, totalChecked, firstBreak }.
 */
export interface IntegrityResult {
  valid: boolean;
  totalChecked: number;
  firstBreak: {
    entryId: string;
    entryDate: string;
    description: string;
    expectedHash: string;
    actualHash: string;
  } | null;
  /** JH2 extensions — optional to preserve the historical shape. */
  reasonCode?: string;
  /** Chain members (posted + formerly-posted, hash != null). */
  members?: number;
  /** Members whose hash is legacy (hashVersion != 'v2'). */
  legacyMembers?: number;
  /** Members whose hash is version 'v2'. */
  v2Members?: number;
  /** true/false when a chain-head row exists; null when no head row exists. */
  headConsistent?: boolean | null;
  /** true when a legacy row could not be certified under its own format. */
  legacyUncertifiable?: boolean;
}

export async function verifyJournalChain(
  companyId: string,
): Promise<IntegrityResult> {
  const { db } = await import('@/lib/db');

  // JH2.12: the topology verdict itself is PURE (DB-free) so the restore
  // transaction can certify a restored chain inside its own tx without
  // touching the global db.
  const rows = (await db.journalEntry.findMany({
    where: { companyId, OR: [{ status: 'posted' }, { status: 'void' }] },
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
        select: {
          glAccountId: true,
          debit: true,
          credit: true,
          description: true,
        },
      },
    },
  })) as unknown as ChainRow[];

  const head = await db.journalChainHead.findUnique({
    where: { companyId },
    select: { lastHash: true, lastEntryId: true },
  });

  const v = buildChainVerdict(companyId, rows, head);
  return {
    valid: v.valid ?? false,
    totalChecked: v.totalChecked ?? 0,
    firstBreak: v.firstBreak ?? null,
    reasonCode: v.reasonCode,
    headConsistent: v.headConsistent,
    members: v.members,
    legacyMembers: v.legacyMembers,
    v2Members: v.v2Members,
    legacyUncertifiable: v.legacyUncertifiable,
  };
}

export interface ChainVerdict {
  valid?: boolean;
  reasonCode?: string;
  firstBreak?: IntegrityResult['firstBreak'];
  totalChecked?: number;
  members?: number;
  legacyMembers?: number;
  v2Members?: number;
  tailId?: string;
  tailHash?: string;
  headConsistent?: boolean | null;
  legacyUncertifiable?: boolean;
}

export interface ChainRow {
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
    description?: string | null;
  }>;
}

/**
 * Pure (DB-free) link-topology chain verdict. JH2.12 extraction: shared by
 * verifyJournalChain (with rows + head from the DB) and by the restore
 * transaction (rows + candidate head from the backup being validated).
 * ROOT = member with previousHash === null; TAIL = lastwalked member.
 */
export function buildChainVerdict(
  companyId: string,
  entries: ChainRow[],
  // head: the actual chain-head row, or null when absent. `undefined`
  // SELECTS derivation mode: head checks are skipped and only the certified
  // TAIL is returned (used by restore inside its own tx).
  head: { lastHash: string | null; lastEntryId: string | null } | null | undefined,
): ChainVerdict {

  // JH2 classification: link-topology based. Members = rows carrying a hash;
  // posted rows without a hash violate the membership contract, never-posted
  // rows (void without hash) are ignored.
  const memberRows = entries.filter((e) => e.hash != null);
  const unsealed = entries.filter(
    (e) => e.status === 'posted' && e.hash == null,
  );
  const unknownVersion = memberRows.filter(
    (m) => m.hashVersion != null && m.hashVersion !== 'v2',
  );
  const meta = {
    members: memberRows.length,
    legacyMembers: memberRows.filter((m) => m.hashVersion == null).length,
    v2Members: memberRows.filter((m) => m.hashVersion === 'v2').length,
  };

  // (1)(7) a posted entry must never lack its seal.
  if (unsealed.length > 0) {
    const u = unsealed[0];
    return {
      valid: false,
      totalChecked: 0,
      firstBreak: {
        entryId: u.id,
        entryDate: u.date.toISOString(),
        description: u.description,
        expectedHash: '<!=null>',
        actualHash: 'null',
      },
      reasonCode: 'MEMBER_HASH_NULL',
      members: 0,
    };
  }

  // Unknown version marker: explicit legacy-uncertifiable evidence. Never
  // silently reinterpreted as tamper, never rewritten.
  if (unknownVersion.length > 0) {
    const u = unknownVersion[0];
    return {
      valid: false,
      totalChecked: 0,
      firstBreak: {
        entryId: u.id,
        entryDate: u.date.toISOString(),
        description: u.description,
        expectedHash: "<hashVersion in {null, 'v2'}>",
        actualHash: String(u.hashVersion),
      },
      reasonCode: 'HASH_VERSION_UNKNOWN',
      legacyUncertifiable: true,
      ...meta,
    };
  }

  if (memberRows.length === 0) {
    // JH2: zero members does NOT automatically PASS — a chain-head row
    // bearing an opaque tail (lastHash/lastEntryId) while the member set is
    // empty means the members were removed under a live head (corruption or
    // artificial deletion). Only a clean head (both nulls) may PASS vacuous.
    if (!head) {
      return { valid: true, totalChecked: 0, firstBreak: null, ...meta };
    }
    if (head.lastHash == null && head.lastEntryId == null) {
      return {
        valid: true,
        totalChecked: 0,
        firstBreak: null,
        headConsistent: true,
        ...meta,
      };
    }
    return {
      valid: false,
      totalChecked: 0,
      firstBreak: {
        entryId: head.lastEntryId ?? '(head)',
        entryDate: 'n/a',
        description: 'chain-head without members',
        expectedHash: '<no members AND lastHash/lastEntryId must be null>',
        actualHash: (head.lastHash ?? 'null') as string,
      },
      reasonCode: 'CHAIN_HEAD_WITHOUT_MEMBERS',
      headConsistent: false,
      ...meta,
    };
  }

  // F1 (JH2.15): reject EXPLICITLY two different members carrying the same
  // stored hash value. Independent from fork (previousHash reuse), id
  // duplicates and recomputed-mismatch detection.
  const storedHashCount = new Map<string, number>();
  for (const m of memberRows) storedHashCount.set(m.hash as string, (storedHashCount.get(m.hash as string) ?? 0) + 1);
  for (const [dupHash, n] of storedHashCount) {
    if (n > 1) {
      const dup = memberRows.find((m) => m.hash === dupHash)!;
      return {
        valid: false,
        totalChecked: 0,
        firstBreak: {
          entryId: dup.id,
          entryDate: dup.date.toISOString(),
          description: dup.description,
          expectedHash: '<unique stored hash per member>',
          actualHash: `${n} members carry ${dupHash.slice(0, 12)}…`,
        },
        reasonCode: 'DUPLICATE_MEMBER_HASH',
        ...meta,
      };
    }
  }

  // (4) no fork: at most one successor per stored previousHash reference.
  const successorCount = new Map<string, number>();
  for (const m of memberRows) {
    if (m.previousHash == null) continue;
    successorCount.set(
      m.previousHash,
      (successorCount.get(m.previousHash) ?? 0) + 1,
    );
  }
  for (const [prevHash, n] of successorCount) {
    if (n > 1) {
      const dup = memberRows.find((m) => m.previousHash === prevHash)!;
      return {
        valid: false,
        totalChecked: 0,
        firstBreak: {
          entryId: dup.id,
          entryDate: dup.date.toISOString(),
          description: dup.description,
          expectedHash: '<unique successor>',
          actualHash: `${n} members chain on ${prevHash}`,
        },
        reasonCode: 'CHAIN_FORK',
        ...meta,
      };
    }
  }

  // (1)(9) exactly one ROOT (previousHash=null).
  const roots = memberRows.filter((m) => m.previousHash == null);
  if (roots.length !== 1) {
    const u = roots[0] ?? memberRows[0];
    return {
      valid: false,
      totalChecked: 0,
      firstBreak: {
        entryId: u.id,
        entryDate: u.date.toISOString(),
        description: u.description,
        expectedHash: '<exactly one ROOT: previousHash=null>',
        actualHash: `<${roots.length} roots>`,
      },
      reasonCode: 'CHAIN_ROOT_COUNT',
      ...meta,
    };
  }

  const root = roots[0];
  // Walk ROOT -> TAIL along stored links (createdAt is NOT an order
  // authority; the stored hash links are the topology).
  const visited = new Set<string>([root.id]);
  const order: typeof memberRows = [root];
  let cur: (typeof memberRows)[number] = root;
  while (true) {
    const next = memberRows.find((m) => m.previousHash === cur.hash);
    if (!next) break;
    if (visited.has(next.id)) {
      return {
        valid: false,
        totalChecked: visited.size,
        firstBreak: {
          entryId: next.id,
          entryDate: next.date.toISOString(),
          description: next.description,
          expectedHash: '<acyclic>',
          actualHash: 'cycle detected',
        },
        reasonCode: 'CHAIN_CYCLE',
        ...meta,
      };
    }
    visited.add(next.id);
    order.push(next);
    cur = next;
  }

  // (2)(3)(6) unique linear chain: full reachability, no orphan, no
  // parallel chain.
  if (visited.size !== memberRows.length) {
    const orphan = memberRows.find((m) => !visited.has(m.id))!;
    return {
      valid: false,
      totalChecked: visited.size,
      firstBreak: {
        entryId: orphan.id,
        entryDate: orphan.date.toISOString(),
        description: orphan.description,
        expectedHash: '<reachable from ROOT>',
        actualHash: 'unreachable / parallel chain',
      },
      reasonCode: 'CHAIN_ORPHAN',
      ...meta,
    };
  }

  // (10) stored previousHash must equal the stored hash of the previous
  // member (the stored link is audited, not just derived).
  for (let i = 1; i < order.length; i++) {
    if (order[i].previousHash !== order[i - 1].hash) {
      const m = order[i];
      return {
        valid: false,
        totalChecked: visited.size,
        firstBreak: {
          entryId: m.id,
          entryDate: m.date.toISOString(),
          description: m.description,
          expectedHash: (order[i - 1].hash ?? 'null') as string,
          actualHash: (m.previousHash ?? 'null') as string,
        },
        reasonCode: 'STORED_PREVIOUS_HASH_MISMATCH',
        ...meta,
      };
    }
  }

  // (11) recomputed hash == stored hash under the row's own hashVersion.
  // Legacy rows are verified under V1 with their stored previousHash and are
  // never converted; every local result is explicit legacy evidence.
  for (const m of order) {
    const isV2 = m.hashVersion === 'v2';
    const expected = isV2
      ? computeEntryHashV2({
          id: m.id,
          companyId: m.companyId,
          date: m.date as Date,
          description: m.description,
          reference: m.reference,
          previousHash: m.previousHash,
          lines: (m as unknown as { lines: JournalHashLinePayload[] }).lines,
        })
      : recomputeLegacyHash(m);
    if (m.hash !== expected) {
      return {
        valid: false,
        totalChecked: visited.size,
        firstBreak: {
          entryId: m.id,
          entryDate: m.date.toISOString(),
          description: m.description,
          expectedHash: expected,
          actualHash: m.hash as string,
        },
        reasonCode: isV2 ? 'HASH_MISMATCH' : 'LEGACY_HASH_RECOMPUTE_MISMATCH',
        legacyUncertifiable: !isV2,
        ...meta,
      };
    }
  }

  // (13) TAIL — unique by fork/orphan checks; single-node ROOT == TAIL.
  // The head is a durable serialization anchor that must mirror the TAIL.
  const tail = cur;
  let headConsistent: boolean | null = null;
  if (head) {
    headConsistent = head.lastHash === tail.hash && head.lastEntryId === tail.id;
    if (!headConsistent) {
      return {
        valid: false,
        totalChecked: visited.size,
        firstBreak: {
          entryId: tail.id,
          entryDate: tail.date.toISOString(),
          description: tail.description,
          expectedHash: head.lastHash ?? 'null',
          actualHash: (tail.hash ?? 'null') as string,
        },
        reasonCode: 'CHAIN_HEAD_MISMATCH',
        ...meta,
      };
    }
  } else if (meta.v2Members > 0 && head !== undefined) {
    return {
      valid: false,
      totalChecked: visited.size,
      firstBreak: {
        entryId: tail.id,
        entryDate: tail.date.toISOString(),
        description: tail.description,
        expectedHash: '<chain-head row>',
        actualHash: 'absent',
      },
      reasonCode: 'MISSING_CHAIN_HEAD',
      ...meta,
    };
  }

  return {
    valid: true,
    totalChecked: visited.size,
    firstBreak: null,
    reasonCode: undefined,
    headConsistent,
    tailId: tail.id,
    tailHash: tail.hash as string,
    ...meta,
  };
}

/**
 * Legacy (V1) hash of a member row, reconstructed from the historical
 * 035a56d contract: HMAC-SHA-256 over [id|companyId|date.toISOString() |
 * description | reference ?? '' | status('posted') | totalDebit.toFixed(2) |
 * totalCredit.toFixed(2) | previousHash ?? '']. Totals derive from the row
 * lines (immutable after POST); the stored previousHash is the declared
 * link. Legacy rows are never converted or re-hashed.
 */
export function recomputeLegacyHash(entry: {
  id: string;
  companyId: string;
  date: Date;
  description: string;
  reference: string | null;
  previousHash: string | null;
  lines: JournalHashLinePayload[];
}): string {
  const totalDebit = entry.lines.reduce((s, l) => s + toMoneyNumber(l.debit), 0);
  const totalCredit = entry.lines.reduce((s, l) => s + toMoneyNumber(l.credit), 0);
  return computeEntryHash({
    id: entry.id,
    companyId: entry.companyId,
    date: entry.date.toISOString(),
    description: entry.description,
    reference: entry.reference,
    status: 'posted',
    totalDebit,
    totalCredit,
    previousHash: entry.previousHash,
  });
}

/**
 * Verify the integrity of the entire audit log hash chain.
 */
export async function verifyAuditChain(): Promise<IntegrityResult> {
  const { db } = await import('@/lib/db');

  const logs = await db.auditLog.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      companyId: true,
      userId: true,
      action: true,
      entity: true,
      entityId: true,
      details: true,
      hash: true,
      previousHash: true,
    },
  });

  if (logs.length === 0) {
    return { valid: true, totalChecked: 0, firstBreak: null };
  }

  const logsWithHash = logs.filter((l) => l.hash);
  const legacyCount = logs.length - logsWithHash.length;

  let previousHash: string | null = null;

  for (let i = 0; i < logsWithHash.length; i++) {
    const log = logsWithHash[i];

    const expectedHash = computeAuditHash({
      id: log.id,
      companyId: log.companyId,
      userId: log.userId,
      action: log.action,
      entity: log.entity,
      entityId: log.entityId,
      details: log.details,
      previousHash,
    });

    if (log.hash !== expectedHash) {
      return {
        valid: false,
        totalChecked: legacyCount + i + 1,
        firstBreak: {
          entryId: log.id,
          entryDate: log.action,
          description: `${log.entity}${log.entityId ? `:${log.entityId}` : ''}`,
          expectedHash,
          actualHash: log.hash as string,
        },
      };
    }

    previousHash = log.hash;
  }

  return { valid: true, totalChecked: logs.length, firstBreak: null };
}
