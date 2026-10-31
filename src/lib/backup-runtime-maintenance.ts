import path from 'node:path';
import { RUNTIME_DIR } from './config/paths';
import { createMaintenanceGate } from './backup-maintenance.mjs';

// Runtime facade has a distinct basename from the plain-Node .mjs implementation.
// Construction performs no storage access; every process uses the same root.
const gate = createMaintenanceGate(path.join(RUNTIME_DIR, 'backup-maintenance'));
export const acquireNormalOperation = () => gate.acquireNormalOperation();
export const withNormalOperation: typeof gate.withNormalOperation = fn => gate.withNormalOperation(fn);
export const withRuntimeOperation: typeof gate.withRuntimeOperation = fn => gate.withRuntimeOperation(fn);
export const withRuntimeOperationSync: typeof gate.withRuntimeOperationSync = fn => gate.withRuntimeOperationSync(fn);
export const maintenanceStatus = () => gate.status();
export const beginMaintenance = () => gate.beginMaintenance();
