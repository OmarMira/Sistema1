import crypto from 'node:crypto';
import { SNAPSHOT_SECTIONS, sealSnapshot } from '@/lib/backup-format';
import type { BackupData } from '@/lib/backup';
import { createPortableContainer } from '@/lib/backup-portable';

export const COMPANY_ID = 'company-recovery-test';
export const COMPANY_LEGAL_NAME = 'Compania Origen S.A.';
export const OWNER = { id: 'user-owner-origin', email: 'owner@example.test' };
export const SOURCE_PASSWORD = 'correct-horse-source-1';
export const OWNER_VERIFIED_AT = '2026-01-02T00:00:00.000Z';

/**
 * Identity inputs that must be supplied INDEPENDENTLY of the file to open it.
 * They are derivational (part of the expensive password KDF), not metadata.
 */
export const OPEN_CONTEXT = Object.freeze({
  ownerUserId: OWNER.id,
  ownerEmail: OWNER.email,
  companyLegalName: COMPANY_LEGAL_NAME,
});

export type Row = Record<string, unknown>;

const ISO = '2026-01-05T10:00:00.000Z';

/** Complete scalar Company row (the source validator requires every column). */
export function companyRow(id: string, legalName: string, extra: Row = {}): Row {
  return {
    id, legalName, entityType: 'BUSINESS', taxId: null, address: null, phone: null, email: null, logo: null,
    streetLine1: '', streetLine2: '', city: '', state: '', zipCode: '', isActive: true,
    isOnboardingComplete: true, entityFirstMode: false, autoRoleAssignment: false,
    maxApplyTransactions: null, createdAt: ISO, updatedAt: ISO, ...extra,
  };
}

export function userRow(id: string, email: string, role = 'super_admin'): Row {
  return {
    id, email, firstName: 'Owner', lastName: 'Origin', isActive: true,
    phone: '', streetLine1: '', streetLine2: '', city: '', state: '', zipCode: '', avatar: '',
    createdAt: ISO, updatedAt: ISO, role,
  };
}

/** A CompanyMember row (tenant role lives here, not on the user account). */
export function memberRow(id: string, userId: string, companyId: string, role = 'employee'): Row {
  return { id, userId, companyId, role, createdAt: ISO, updatedAt: ISO };
}

/** Audit row shaped exactly like a locally chained row, HMAC'd under `secret`. */
export function auditRow(
  id: string,
  companyId: string,
  previousHash: string | null,
  secret = process.env.HMAC_SECRET ?? '',
  createdAt = ISO,
): Row {
  const row: Row = {
    id, companyId, userId: null, action: 'JOURNAL_POSTED', entity: 'JournalEntry',
    entityId: 'entry-1', details: null, previousHash, createdAt,
  };
  row.hash = crypto.createHmac('sha256', secret).update([
    id, companyId, '', 'JOURNAL_POSTED', 'JournalEntry', 'entry-1', '', previousHash ?? '',
  ].join('|')).digest('hex');
  return row;
}

export function journalRow(
  id: string,
  companyId: string,
  secret = process.env.HMAC_SECRET ?? '',
): Row {
  const lines = [{ glAccountId: 'gl-1', debit: '100.00', credit: '0.00', description: 'sale' }];
  const hash = crypto.createHmac('sha256', secret).update(`entry:${id}`).digest('hex');
  return {
    id, companyId, date: ISO, description: 'Asiento de origen', reference: null,
    status: 'posted', hash, previousHash: null, hashVersion: 'v2', lines,
  };
}

export function makeSnapshot(overrides: {
  companyId?: string;
  legalName?: string;
  users?: Row[];
  companyMembers?: Row[];
  auditLogs?: Row[];
  journalEntries?: Row[];
  journalLines?: Row[];
  journalChainHead?: BackupData['data']['journalChainHead'];
} = {}): BackupData {
  const companyId = overrides.companyId ?? COMPANY_ID;
  const legalName = overrides.legalName ?? COMPANY_LEGAL_NAME;
  const data = {
    company: [companyRow(companyId, legalName)],
    companyConfig: null,
    journalChainHead: overrides.journalChainHead ?? null,
  } as unknown as BackupData['data'];
  for (const section of SNAPSHOT_SECTIONS) {
    if (section === 'company') continue;
    (data as unknown as Record<string, Row[]>)[section] = [];
  }
  data.systemConfig = [];
  data.users = overrides.users ?? [userRow(OWNER.id, OWNER.email)];
  data.companyMembers = overrides.companyMembers ?? [];
  data.auditLogs = overrides.auditLogs ?? [];
  data.journalEntries = overrides.journalEntries ?? [];
  data.journalLines = overrides.journalLines ?? [];
  const recordCounts = Object.fromEntries([
    ...SNAPSHOT_SECTIONS.map((section) => [section, ((data as unknown as Record<string, Row[]>)[section] ?? []).length]),
    ['companyConfig', false],
  ]) as BackupData['manifest']['recordCounts'];
  return {
    manifest: {
      version: '2.1.0',
      id: crypto.randomUUID(),
      createdAt: ISO,
      companyId,
      companyInfo: { id: companyId, legalName, taxId: null },
      recordCounts,
      fidelity: { monetary: 'decimal-18,2', jsonNulls: [] },
    },
    data,
  } as BackupData;
}

/**
 * The real encrypted portable file: whole payload AEAD-sealed, no plaintext.
 * `stamp` overrides the sealed source-owner credential so a test can describe a
 * file whose owner was never verified.
 */
export function portableFile(
  snapshot: BackupData,
  password = SOURCE_PASSWORD,
  owner = OWNER,
  stamp: { emailVerifiedAt?: string | null; legacyUser?: boolean } = {},
): string {
  sealSnapshot(snapshot);
  return createPortableContainer({
    snapshot,
    password,
    owner: {
      ownerUserId: owner.id,
      ownerEmail: owner.email,
      emailVerifiedAt: stamp.emailVerifiedAt === undefined ? OWNER_VERIFIED_AT : stamp.emailVerifiedAt,
      legacyUser: stamp.legacyUser === true,
      verifiedAt: OWNER_VERIFIED_AT,
    },
    companyLegalName: snapshot.manifest.companyInfo.legalName,
    createdAt: snapshot.manifest.createdAt,
  });
}

/** Locally sealed snapshot text (internal storage/authenticated restore format). */
export function localText(snapshot: BackupData): string {
  sealSnapshot(snapshot);
  return JSON.stringify(snapshot);
}

export function withEnv<T>(values: Record<string, string>, work: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return work();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export interface FakeState {
  users: Row[];
  companies: Row[];
  members: Row[];
  audits: Row[];
  journals: Row[];
}

/**
 * Minimal in-memory stand-in for the narrow Prisma surface the portable
 * bootstrap restore touches. No real database, no ambient connection.
 */
export function fakeClient(seed: Partial<FakeState> = {}) {
  const state: FakeState = { users: [], companies: [], members: [], audits: [], journals: [], ...seed };
  const client = {
    $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(client),
    $queryRawUnsafe: async <T = unknown>() => [] as unknown as T,
    user: {
      count: async () => state.users.length,
      findMany: async () => state.users.map((user) => ({ id: user.id, email: user.email })),
      findUnique: async ({ where }: { where: Row }) => {
        if (typeof where.id === 'string') return state.users.find((u) => u.id === where.id) ?? null;
        if (typeof where.email === 'string') return state.users.find((u) => u.email === where.email) ?? null;
        return null;
      },
      create: async ({ data }: { data: Row }) => {
        state.users.push({ ...data });
        return data;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = state.users.length;
        state.users = state.users.filter((u) => u.id !== where.id);
        return { count: before - state.users.length };
      },
    },
    company: {
      count: async () => state.companies.length,
      findUnique: async ({ where }: { where: Row }) =>
        state.companies.find((company) => company.id === where.id) ?? null,
      create: async ({ data }: { data: Row }) => {
        state.companies.push({ ...data });
        return data;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = state.companies.length;
        state.companies = state.companies.filter((c) => c.id !== where.id);
        return { count: before - state.companies.length };
      },
    },
    companyMember: {
      findUnique: async ({ where }: { where: { userId_companyId: { userId: string; companyId: string } } }) =>
        state.members.find((m) =>
          m.userId === where.userId_companyId.userId && m.companyId === where.userId_companyId.companyId) ?? null,
      create: async ({ data }: { data: Row }) => {
        state.members.push({ ...data });
        return data;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = state.members.length;
        state.members = state.members.filter((m) => !(m.userId === where.userId && m.companyId === where.companyId));
        return { count: before - state.members.length };
      },
    },
    journalEntry: {
      count: async ({ where }: { where: Row }) =>
        state.journals.filter((row) => row.companyId === where.companyId).length,
      findMany: async ({ where }: { where: Row }) =>
        state.journals.filter((row) => row.companyId === where.companyId).map((row) => ({ ...row })),
    },
    bankStatement: {
      count: async () => 0,
    },
    auditLog: {
      count: async () => state.audits.length,
      findMany: async ({ where }: { where?: Row } = {}) =>
        state.audits
          .filter((a) => (typeof where?.companyId === 'string' ? a.companyId === where.companyId : true))
          .map((a) => ({ ...a })),
      create: async ({ data }: { data: Row }) => {
        state.audits.push({ ...data });
        return data;
      },
    },
  };
  return { client, state };
}

export function fakeProvenance() {
  const records: Array<Record<string, unknown>> = [];
  return {
    records,
    recorder: {
      record: async (record: Record<string, unknown>) => {
        records.push(record);
      },
    },
  };
}
