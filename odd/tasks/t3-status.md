# T3 UI/API — Status (feat/company-backup-reliability)

API routes present: /api/backup (POST/GET/DELETE), /api/backup/restore (POST multipart + base64, validation + restore), /api/backup/[filename] (GET/DELETE). Components present: BackupPage.tsx, BackupItem.tsx, RestoreDropZone.tsx, BackupTab.tsx.
S3/S5: preview/confirmation, errors, exact bytes. Byte fidelity already verified in T3a (9a8c313, download handler). Restore confirmation exists via preview (backup-restore.ts previewCompanyRestore). UI cache refresh not independently verified.
Tests: installation-wizard.test.tsx exists for onboarding wizard; backup-specific UI tests not independently confirmed.
Status: T3 implemented in source; independent verifier unavailable (same transport failures as T1/T2); no browser/crash proof (T4) yet; rollout gated until T4/T5.
