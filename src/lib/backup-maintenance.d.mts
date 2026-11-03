export class MaintenanceAdmissionError extends Error {
  statusCode: 503;
  code: 'BACKUP_MAINTENANCE';
  constructor(message?: string, cause?: unknown);
}
export interface NormalOperationLease {
  /** Durable lease identity; the only handle a maintenance transition may exclude. */
  readonly id: string;
  run<T>(operation: () => T | Promise<T>): Promise<T>;
  /** Synchronous counterpart; settled runs only once all nested work finishes. */
  runSync<T>(operation: () => T, settled?: () => void): T;
  /** Only the acquiring capability can release; refuses while callbacks run. */
  release(): void;
}
export interface MaintenanceOwner {
  readonly id: string;
  /** Lease identity this owner ignores; null for operator/resumed owners. */
  readonly excludedLeaseId: string | null;
  /** Timeout leaves the durable marker in place. Never reclaims old leases. */
  drain(options?: { timeoutMs?: number }): Promise<void>;
  /** In-process capability only; does not grant any normal/API admission bypass. */
  runRecovery<T>(operation: () => T | Promise<T>): Promise<T>;
  /** Explicit reopening after drain/reconciliation; never automatic on errors. */
  release(): void;
}
export interface MaintenanceGate {
  status(): { marked: boolean; leases: number };
  acquireNormalOperation(): NormalOperationLease;
  withNormalOperation<T>(operation: () => T | Promise<T>): Promise<T>;
  /** Runtime writers only: accepts live owned recovery, never API admission. */
  withRuntimeOperation<T>(operation: () => T | Promise<T>): Promise<T>;
  /** Preserves synchronous return timing; promise misuse throws and retains admission. */
  withRuntimeOperationSync<T>(operation: () => T): T;
  /**
   * excludeCurrentOperation: the admitted operation requesting the transition
   * ignores its OWN lease identity (captured in this call) for drain, recovery
   * admission and release. Every other lease still blocks, and the exclusion is
   * inert when no admitted operation is active. Operators use resumeMaintenance.
   */
  beginMaintenance(options?: { excludeCurrentOperation?: boolean }): MaintenanceOwner;
  /** Trusted reconciliation only. Exact marker identity; recovery remains exclusive. */
  resumeMaintenance(id: string): MaintenanceOwner;
}
export function createMaintenanceGate(storageRoot: string): MaintenanceGate;
export function configuredDataRoot(): string | undefined;
export function runtimeDirectory(): string;
