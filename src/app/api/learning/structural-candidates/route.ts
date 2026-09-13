import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCompanyContext } from '@/lib/context-storage';
import { requireCompanyRole } from '@/lib/rbac';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { handleRouteError } from '@/lib/route-error-handler';
import {
  createAdapter,
  discoverStructuralCandidateForGroup,
  recordStructuralCandidate,
  OBSERVATION_TYPE,
  STRUCTURAL_CANDIDATE_TYPE,
  AUTHORIZED_PATTERN_TYPE,
  type StructuralCandidateContent,
  type StructuralGroupKey,
  type StructuralSegment,
} from '@/memory/classification-knowledge';

/**
 * Structural candidate productive surface (KE-GENERALIZATION-UI-001).
 *
 * GET  → lists PENDING structural candidates for the ACTIVE company
 *        (candidates not yet referenced by an authorized pattern).
 * POST → runs structural discovery over the company's accumulated
 *        classification observations and persists candidates through the
 *        EXISTING domain authority. Discovery NEVER authorizes: the only
 *        writer of authorized patterns remains authorizeStructuralCandidate,
 *        invoked exclusively by the separate human authorize endpoint.
 *
 * Tenant isolation: every read/write is scoped by the session companyId via
 * the adapter; no client-supplied companyId is ever trusted.
 *
 * NOTE on grouping: the discovery ALGORITHM (similarity, thresholds, segment
 * comparison, candidate generation) lives entirely in
 * discoverStructuralCandidateForGroup. This route only partitions the
 * company's OWN persisted observations by exact equality of their contract
 * fields (entityId, glAccountId, direction) to know WHICH groups to offer to
 * the domain authority — no similarity or threshold logic exists here.
 */

export interface PendingCandidateApiEntry {
  candidateItemId: string;
  entityId: string;
  glAccountId: string;
  direction: 'debit' | 'credit' | 'any';
  segments: StructuralSegment[];
  observationIds: string[];
}

interface ParsedObservationKey {
  entityId: string;
  glAccountId: string;
  direction: string;
}

function parseObservationGroupKey(content: string): ParsedObservationKey | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === 'object' && parsed !== null
      && typeof (parsed as Record<string, unknown>).entityId === 'string'
      && typeof (parsed as Record<string, unknown>).glAccountId === 'string'
      && typeof (parsed as Record<string, unknown>).direction === 'string'
    ) {
      const p = parsed as Record<string, string>;
      return { entityId: p.entityId, glAccountId: p.glAccountId, direction: p.direction };
    }
    return null;
  } catch {
    return null;
  }
}

function parseCandidateContent(content: string): StructuralCandidateContent | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed === 'object' && parsed !== null
      && typeof (parsed as Record<string, unknown>).entityId === 'string'
      && typeof (parsed as Record<string, unknown>).glAccountId === 'string'
      && typeof (parsed as Record<string, unknown>).direction === 'string'
      && Array.isArray((parsed as Record<string, unknown>).segments)
      && Array.isArray((parsed as Record<string, unknown>).observationIds)
    ) {
      return parsed as StructuralCandidateContent;
    }
    return null;
  } catch {
    return null;
  }
}

export const GET = apiHandler(async (_request: NextRequest, _context: RouteContext) => {
  try {
    const { userId, companyId } = requireCompanyContext();
    await requireCompanyRole(companyId, ['company_admin']);

    const adapter = createAdapter(db, (fn) => db.$transaction(fn));

    const candidateItems = await adapter.getByType(companyId, STRUCTURAL_CANDIDATE_TYPE);
    const authorizedItems = await adapter.getByType(companyId, AUTHORIZED_PATTERN_TYPE);

    // A candidate is PENDING while no authorized pattern references it via
    // sourceCandidateId. The authorization semantics themselves remain in the
    // domain (authorizeStructuralCandidate); this is transport-level status.
    const authorizedCandidateIds = new Set<string>();
    for (const item of authorizedItems) {
      if (item.status !== 'active') continue;
      try {
        const parsed: unknown = JSON.parse(item.content);
        const sourceCandidateId = (parsed as Record<string, unknown>)?.sourceCandidateId;
        if (typeof sourceCandidateId === 'string') {
          authorizedCandidateIds.add(sourceCandidateId);
        }
      } catch {
        // Malformed authorization — cannot reference anything
      }
    }

    const candidates: PendingCandidateApiEntry[] = [];
    for (const item of candidateItems) {
      if (item.status !== 'active') continue;
      if (authorizedCandidateIds.has(item.id)) continue;
      const content = parseCandidateContent(item.content);
      if (!content) continue;
      candidates.push({
        candidateItemId: item.id,
        entityId: content.entityId,
        glAccountId: content.glAccountId,
        direction: content.direction,
        segments: content.segments,
        observationIds: content.observationIds,
      });
    }

    return NextResponse.json({ success: true, candidates });
  } catch (error: unknown) {
    return handleRouteError(error, 'GET_STRUCTURAL_CANDIDATES_ERROR');
  }
}, { requireMembership: true });

export const POST = apiHandler(async (_request: NextRequest, _context: RouteContext) => {
  try {
    const { userId, companyId } = requireCompanyContext();
    await requireCompanyRole(companyId, ['company_admin']);

    const adapter = createAdapter(db, (fn) => db.$transaction(fn));

    // Snapshot of already-persisted candidate ids (for duplicate reporting).
    const existingCandidateIds = new Set(
      (await adapter.getByType(companyId, STRUCTURAL_CANDIDATE_TYPE))
        .filter((item) => item.status === 'active')
        .map((item) => item.id),
    );

    // Enumerate the DISTINCT observation group keys of THIS company.
    const observationItems = await adapter.getByType(companyId, OBSERVATION_TYPE);
    const groupKeys = new Map<string, StructuralGroupKey>();
    for (const item of observationItems) {
      if (item.status !== 'active') continue;
      const key = parseObservationGroupKey(item.content);
      if (!key) continue;
      const mapKey = `${key.entityId}||${key.glAccountId}||${key.direction}`;
      if (!groupKeys.has(mapKey)) {
        groupKeys.set(mapKey, {
          companyId,
          entityId: key.entityId,
          glAccountId: key.glAccountId,
          direction: key.direction as StructuralGroupKey['direction'],
        });
      }
    }

    // Run the EXISTING discovery authority per group, persist through the
    // EXISTING record authority. Authorization NEVER happens here.
    let candidatesFound = 0;
    let candidatesRecorded = 0;
    let duplicatesSkipped = 0;
    let groupsWithoutCandidate = 0;

    for (const key of groupKeys.values()) {
      const discovery = await discoverStructuralCandidateForGroup(adapter, key);
      if (discovery.kind !== 'candidate') {
        groupsWithoutCandidate += 1;
        continue;
      }
      candidatesFound += 1;
      const record = await recordStructuralCandidate(adapter, discovery.candidate);
      if (!record.ok) {
        logger.warn('[STRUCTURAL_DISCOVERY] Failed to record candidate', {
          companyId,
          userId,
          entityId: discovery.candidate.entityId,
          error: record.error,
        });
        continue;
      }
      if (existingCandidateIds.has(record.candidateId)) {
        duplicatesSkipped += 1;
      } else {
        candidatesRecorded += 1;
      }
    }

    return NextResponse.json({
      success: true,
      groupsExamined: groupKeys.size,
      candidatesFound,
      candidatesRecorded,
      duplicatesSkipped,
      groupsWithoutCandidate,
    });
  } catch (error: unknown) {
    return handleRouteError(error, 'POST_STRUCTURAL_DISCOVERY_ERROR');
  }
}, { requireMembership: true });
