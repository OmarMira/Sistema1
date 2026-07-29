import type { EvidenceEntry, OperationState } from './types';

export class Evidence {
  private readonly entries: EvidenceEntry[] = [];

  write(
    state: OperationState,
    intentId: string,
    detail: string,
    snapshot?: Record<string, string>,
  ): void {
    this.entries.push({
      timestamp: Date.now(),
      state,
      intentId,
      detail,
      snapshot: snapshot ? { ...snapshot } : undefined,
    });
  }

  read(): readonly EvidenceEntry[] {
    return this.entries.map((entry) => ({
      ...entry,
      snapshot: entry.snapshot ? { ...entry.snapshot } : undefined,
    }));
  }
}