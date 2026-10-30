export class MaintenanceAdmissionError extends Error {
  statusCode: 503;
  code: 'BACKUP_MAINTENANCE';
  constructor(message?: string, cause?: unknown);
}
export interface NormalOperationLease {
  run<T>(operation: () => T | Promise<T>): Promise<T>;
  /** Synchronous counterpart; settled runs only once all nested work finishes. */
  runSync<T>(operation: () => T, settled?: () => void): T;
  /** Only the acquiring capability can release; refuses while callbacks run. */
  release(): void;
}
export interface MaintenanceOwner {
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
  beginMaintenance(): MaintenanceOwner;
}
export function createMaintenanceGate(storageRoot: string): MaintenanceGate;
export function configuredDataRoot(): string | undefined;
export function runtimeDirectory(): string;
