// Compatibility for explicit TypeScript consumers. Application imports use the
// unambiguous runtime facade; the plain-Node implementation remains .mjs.
export {
  acquireNormalOperation,
  withNormalOperation,
  withRuntimeOperation,
  withRuntimeOperationSync,
  maintenanceStatus,
  beginMaintenance,
} from './backup-runtime-maintenance';
