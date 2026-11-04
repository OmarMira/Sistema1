/** Receipt absence is authoritative only after the caller has serialized with
 * the original restore transaction; a failed query must never call this as null.
 */
export function recoveryReceiptEvidence(journal, receipt) {
  if (receipt === null) return 'absent';
  if (!receipt || receipt.id !== journal.operationId || receipt.companyId !== journal.companyId || receipt.action !== 'COMPANY_RESTORE_COMMITTED') return 'unknown';
  try { return JSON.parse(receipt.details).checksum === journal.checksum ? 'committed' : 'unknown'; }
  catch { return 'unknown'; }
}
