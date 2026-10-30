import path from 'node:path';
import { RUNTIME_DIR } from './config/paths';
import { createMaintenanceGate } from './backup-maintenance.mjs';

// Construction does not read or create storage. Each admission resolves the same
// configured runtime directory; standalone scripts import the .mjs contract.
const gate = createMaintenanceGate(path.join(RUNTIME_DIR, 'backup-maintenance'));
export const acquireNormalOperation = () => gate.acquireNormalOperation();
export const withNormalOperation: typeof gate.withNormalOperation = fn => gate.withNormalOperation(fn);
export const withRuntimeOperation: typeof gate.withRuntimeOperation = fn => gate.withRuntimeOperation(fn);
export const withRuntimeOperationSync: typeof gate.withRuntimeOperationSync = fn => gate.withRuntimeOperationSync(fn);
export const maintenanceStatus = () => gate.status();
export const beginMaintenance = () => gate.beginMaintenance();
