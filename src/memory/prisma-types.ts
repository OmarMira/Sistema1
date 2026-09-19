// Memory Core — Prisma Contract
//
// Minimal structural type representing exactly the Prisma operations
// used by MemoryRepository, MemoryService, and MemoryAdapter.
//
// This type is satisfied by both `PrismaClient` and `ExtendedPrismaClient`
// (the return type of `$extends()`), allowing Memory Core to accept the
// real Prisma client used by Sistema1 without type assertions.
//
// Uses UncheckedCreateInput variants because MemoryRepository passes
// FK fields directly (e.g., companyId) rather than relation objects
// (e.g., company: { connect: { id } }).

import type { Prisma } from '@prisma/client';
import type {
  MemoryItem,
  MemoryVersion,
  Relationship,
  Contradiction,
  TraceabilityLog,
  EvolutionLink,
  ConfidenceLog,
} from '@prisma/client';

// ─── Transaction Client ──────────────────────────────────────────

/**
 * Type representing the client available inside a Prisma interactive
 * transaction callback. Has all model delegates and $queryRaw.
 *
 * Structurally compatible with Omit<PrismaClient, ITXClientDenyList>.
 */
export type TransactionClient = Omit<MemoryPrismaClient, '$transaction'>;

// ─── Transaction Runner ──────────────────────────────────────────

/**
 * Function type for executing interactive transactions.
 * Receives a callback that operates on a TransactionClient.
 *
 * At runtime, this is typically `(fn) => db.$transaction(fn)`.
 * The ExtendedPrismaClient satisfies MemoryPrismaClient, so the
 * callback parameter is type-safe without casts.
 */
export type TransactionRunner = <R>(fn: (tx: TransactionClient) => Promise<R>) => Promise<R>;

// ─── Contract ─────────────────────────────────────────────────

/**
 * Minimal Prisma contract for Memory Core.
 *
 * Contains ONLY the operations actually called by MemoryRepository.
 * Does NOT require $on, $connect, $disconnect, $use, or $extends
 * because Memory Core never uses them.
 *
 * Does NOT include $transaction because PrismaClient's overloaded
 * $transaction (batch + interactive) is structurally incompatible
 * with a single-signature contract. Instead, repository methods that
 * need transactions accept an optional `tx: TransactionClient` parameter.
 */
export interface MemoryPrismaClient {
  // ─── Raw query ────────────────────────────────────────────────

  $queryRaw<T>(query: TemplateStringsArray, ...values: unknown[]): Promise<T>;

  // ─── MemoryItem ──────────────────────────────────────────────

  memoryItem: {
    create(args: { data: Prisma.MemoryItemUncheckedCreateInput }): Promise<MemoryItem>;
    findFirst(args: { where: Prisma.MemoryItemWhereInput; orderBy?: Prisma.MemoryItemOrderByWithRelationInput | Prisma.MemoryItemOrderByWithRelationInput[] }): Promise<MemoryItem | null>;
    findMany(args: {
      where: Prisma.MemoryItemWhereInput;
      orderBy?: Prisma.MemoryItemOrderByWithRelationInput | Prisma.MemoryItemOrderByWithRelationInput[];
      select?: Prisma.MemoryItemSelect;
    }): Promise<MemoryItem[]>;
    update(args: {
      where: Prisma.MemoryItemWhereUniqueInput;
      data: Prisma.MemoryItemUpdateInput;
    }): Promise<MemoryItem>;
  };

  // ─── MemoryVersion ───────────────────────────────────────────

  memoryVersion: {
    create(args: { data: Prisma.MemoryVersionUncheckedCreateInput }): Promise<MemoryVersion>;
    findFirst(args: {
      where: Prisma.MemoryVersionWhereInput;
      orderBy?: Prisma.MemoryVersionOrderByWithRelationInput;
      select?: Prisma.MemoryVersionSelect;
    }): Promise<MemoryVersion | null>;
    findMany(args: {
      where: Prisma.MemoryVersionWhereInput;
      orderBy?: Prisma.MemoryVersionOrderByWithRelationInput;
    }): Promise<MemoryVersion[]>;
  };

  // ─── Relationship ────────────────────────────────────────────

  relationship: {
    create(args: { data: Prisma.RelationshipUncheckedCreateInput }): Promise<Relationship>;
    findMany(args: {
      where: Prisma.RelationshipWhereInput;
      include?: Prisma.RelationshipInclude;
    }): Promise<Relationship[]>;
  };

  // ─── Contradiction ───────────────────────────────────────────

  contradiction: {
    create(args: { data: Prisma.ContradictionUncheckedCreateInput }): Promise<Contradiction>;
    findMany(args: {
      where: Prisma.ContradictionWhereInput;
    }): Promise<Contradiction[]>;
  };

  // ─── TraceabilityLog ─────────────────────────────────────────

  traceabilityLog: {
    create(args: { data: Prisma.TraceabilityLogUncheckedCreateInput }): Promise<TraceabilityLog>;
    findMany(args: {
      where: Prisma.TraceabilityLogWhereInput;
      orderBy?: Prisma.TraceabilityLogOrderByWithRelationInput;
    }): Promise<TraceabilityLog[]>;
  };

  // ─── EvolutionLink ───────────────────────────────────────────

  evolutionLink: {
    create(args: { data: Prisma.EvolutionLinkUncheckedCreateInput }): Promise<EvolutionLink>;
    findMany(args: {
      where: Prisma.EvolutionLinkWhereInput;
    }): Promise<EvolutionLink[]>;
  };

  // ─── ConfidenceLog ───────────────────────────────────────────

  confidenceLog: {
    create(args: { data: Prisma.ConfidenceLogUncheckedCreateInput }): Promise<ConfidenceLog>;
    findMany(args: {
      where: Prisma.ConfidenceLogWhereInput;
      orderBy?: Prisma.ConfidenceLogOrderByWithRelationInput;
    }): Promise<ConfidenceLog[]>;
  };
}
