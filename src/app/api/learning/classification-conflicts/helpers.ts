import type { PendingConflictEntry } from '@/memory/classification-knowledge';

export interface PendingConflictApiEntry {
  conflictItemId: string;
  kind: string;
  authorizedPatternIds: string[];
  exactTreatmentItemIds?: string[];
  conflictingGlAccountId: string;
  observationIds: string[];
  detectedAt: string;
}

export function toPendingConflictApiEntry(entry: PendingConflictEntry): PendingConflictApiEntry {
  const apiEntry: PendingConflictApiEntry = {
    conflictItemId: entry.conflictItemId,
    kind: entry.content.kind,
    authorizedPatternIds: entry.content.authorizedPatternIds,
    conflictingGlAccountId: entry.content.conflictingGlAccountId,
    observationIds: entry.content.observationIds,
    detectedAt: entry.content.detectedAt,
  };
  // Legacy conflicts (pre KE-EVOL-002) omit exactTreatmentItemIds — the field
  // stays absent, it is never invented.
  if (entry.content.exactTreatmentItemIds !== undefined) {
    apiEntry.exactTreatmentItemIds = entry.content.exactTreatmentItemIds;
  }
  return apiEntry;
}
