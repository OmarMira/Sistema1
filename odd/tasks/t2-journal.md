# T2 Journal — Coordinated DB + Files Recovery (feat/company-backup-reliability)

L13. T2 autorizado como T2 (S1/S2/S4); T1 fidelity repair precede safety journals.
L14–L22. Implementation observed: backup-restore.ts (Serializable tx, advisory lock, preimage safety, audit receipt, no auto-retry), backup-storage.ts (publishBackup, readCompanyConfig), backup-validation.ts (source/destination/identity validation, blockers for file/config changes, strict tenant check).
Evidence: 115 adapter tests (public PG) + 135 isolated suite pass (exit 0, 3.29s) with synthetic PG 16.15 at 127.0.0.1:49674, preimage SHA256 retained (verify-fidelity-L4LD9t), auditLog receipt structured (operationId, companyId, checksum).
Unconfirmed / unavailable: independent gentle-ai-verify (timed out ×2); real browser/crash acceptance (T4) absent; external file/assets restoration explicitly blocked (blockers list: RESTORE_FILES_REQUIRED, RESTORE_ASSETS_REQUIRED) rather than falsely claimed; ambient DB unchanged.
No installer / AEX / DB connection mutation.
Status: T2 implemented; not yet independently verified; rollout gated until T4/T5 proof.
