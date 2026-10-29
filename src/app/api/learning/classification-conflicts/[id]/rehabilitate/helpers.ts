import type { RehabilitationResult } from '@/memory/classification-knowledge';

const BUSINESS_PRECONDITION_STATUS = 409;

export function mapRehabilitationResult(
  result: RehabilitationResult,
): { body: Record<string, unknown>; status: number } {
  switch (result.status) {
    case 'REHABILITATED':
      return {
        body: {
          success: true,
          status: 'REHABILITATED',
          knowledgeItemId: result.knowledgeItemId,
          conflictItemId: result.conflictItemId,
          rehabilitationEventId: result.rehabilitationEventId,
        },
        status: 200,
      };
    case 'ALREADY_CERTAIN':
      return {
        body: {
          success: true,
          status: 'ALREADY_CERTAIN',
          knowledgeItemId: result.knowledgeItemId,
        },
        status: 200,
      };
    case 'CONFLICT_NOT_RESOLVED':
      return {
        body: {
          success: false,
          status: 'CONFLICT_NOT_RESOLVED',
          conflictItemId: result.conflictItemId,
          error: 'Conflict must be explicitly resolved before rehabilitation',
          code: 'CONFLICT_NOT_RESOLVED',
        },
        status: BUSINESS_PRECONDITION_STATUS,
      };
    case 'OTHER_PENDING_CONFLICT':
      return {
        body: {
          success: false,
          status: 'OTHER_PENDING_CONFLICT',
          conflictItemId: result.conflictItemId,
          blockingConflictItemIds: result.blockingConflictItemIds,
          error: 'Another pending conflict still implicates this knowledge item',
          code: 'OTHER_PENDING_CONFLICT',
        },
        status: BUSINESS_PRECONDITION_STATUS,
      };
    case 'NOT_IMPLICATED':
      return {
        body: {
          success: false,
          status: 'NOT_IMPLICATED',
          conflictItemId: result.conflictItemId,
          error: 'Knowledge item is not explicitly implicated by this conflict',
          code: 'NOT_IMPLICATED',
        },
        status: BUSINESS_PRECONDITION_STATUS,
      };
    case 'NOT_UNCERTAIN':
      return {
        body: {
          success: false,
          status: 'NOT_UNCERTAIN',
          knowledgeItemId: result.knowledgeItemId,
          error: 'Knowledge item is not in uncertain state',
          code: 'NOT_UNCERTAIN',
        },
        status: BUSINESS_PRECONDITION_STATUS,
      };
    // NOT_FOUND / ERROR are handled by the caller (status 404 / 500) and
    // must not be audited as productive actions.
    case 'NOT_FOUND':
      return {
        body: { error: 'Conflict not found', code: 'CONFLICT_NOT_FOUND' },
        status: 404,
      };
    case 'ERROR':
      return {
        body: { error: 'Failed to rehabilitate classification knowledge' },
        status: 500,
      };
  }
}
