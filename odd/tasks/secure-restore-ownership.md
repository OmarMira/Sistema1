# Secure restore ownership + certified historical restore
Objective: make company backup/restore professional and theft-proof — restore proves ownership with the creating super-admin's password; historical audit segments restore cleanly on empty installations and as new companies.
Branch: feat/secure-restore-ownership (from origin/main 257e6d9). Delivery: two chained PRs (Phase 1: ownership + re-anchor; Phase 2: restore-as-new-company). Runner: Vitest, isolated-PG suites, CI build-and-secret-scan.

## Specs
- S1: "cuando alguien va a hacer una restauracion de una empresa ya sea desde cero o agregando a las ya existentes en el sistema la clave que pide debe ser la del super admin que creo la empresa del backup no cualquier cosa" — every restore path (bootstrap from-zero and in-system into existing company) must verify the ownership credential of the backup's creating super-admin before restoring anything.
- S2: "porque si es cualquier cosa alguien que robe un backup puede reinstalarlo y ver la informacion que cualquier lado" — a stolen backup file must not be restorable without the owner's credential.
- S3: "el sistema de backup y restauracion debe ser profesional y a prueba de robo de informacion" — threat cases (stolen file, wrong password, forged history, lost password) are pinned by tests, not prose.
- S4: "que pasa si tengo 5 empresas y quiero restaurar la 6 que esta en un backup" — Phase 2: a backup may be restored as a NEW company into an active installation (created by super_admin) without touching existing companies.
- S5 (owner decision, Log L3): legacy plain-text backups are rejected by default with a clear Spanish message; no silent acceptance.
- S6 (owner decision, Log L3): the re-anchoring of an orphaned audit segment is only allowed on a verifiably empty destination AND with ownership proof; it must write a sealed RESTORE_REBASE entry documenting backup id, original predecessor hash and date. On non-empty destinations the current RESTORE_CHAIN refusal is unchanged.
- S7: creating a backup requires the creating company_admin/super_admin to re-enter their password (sudo-style); the verifier (argon2id, per-backup salt) is embedded in the sealed section only — never the password, never in plain sections.

## Tasks
- T1 [S7] writer; verifier generation + embed at backup creation (password re-entry on POST /api/backup); commit pending. Risk: item 3 (security).
- T2 [S1,S2] writer; restore ownership verification (bootstrap + in-system); refuse RESTORE_OWNERSHIP on missing/mismatched verifier; commit pending. Risk: item 3.
- T3 [S6] writer; historical re-anchoring on provably-empty destination; commit pending. Risk: items 2,3.
- T4 [S5] writer; legacy plain backups rejected with Spanish message; commit pending.
- T5 [S4] writer; Phase 2 restore-as-new-company with closed historical segment + isolation tests; commit pending. Risk: items 2,3.
- T6 [S3] verifier; full-cycle E2E (create→wipe→restore→data+audits intact; theft scenarios refused) + independent verification; pending.
- T7 [S3] docs: company-backup-format.md, company-backup-recovery.md, UI copy; pending.

## Log
- L1: "quiero que planifiques todo esto al detalle para que podamos solucionar todo este problema"
- L2 context: owner's backup (cmw1ducll...json, 2.1.0, 2026-11-04) refused by RESTORE_CHAIN on a verifiably empty destination — its audit segment starts anchored to a predecessor lost with the old installation. Data intact (302 transactions); chain unrootable. Same wall will hit every customer migrating machines or after a secret change.
- L3 (owner decisions this session): restore must prove ownership with the creating super-admin's password (S1/S2); no easy re-sign shortcut outside the product ("no un atajo facilista"); legacy plain backups rejected by default; historical restore allowed only on empty destination with ownership proof and a sealed RESTORE_REBASE record; Phase 2 restores a backup as a new company via admin creation.
- L4 (2026-11-05): T1+T2 delivered and committed (0c8155f, 2247 lines incl. tests): sudo-style creation, scrypt verifier in sealed section, RESTORE_OWNERSHIP on both paths, UI + i18n, all suites green (39+12+55) — verified by parent after a worker capacity crash (work survived). Stray Cuba08JJ dir removed. scrypt chosen over argon2id (no new dependency; parameters stored per backup — spec reconciled). T3+T4 wave running.
- Security notes: backups since wave 5 exclude passwordHash (kept); sealed backups are AES-256-GCM with installation SESSION_SECRET (kept); verifier = argon2id with per-backup salt, stored only in the sealed section; ownership check precedes every mutation; re-anchoring never touches a non-empty destination.
