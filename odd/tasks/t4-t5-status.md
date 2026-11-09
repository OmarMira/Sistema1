# T4/T5 — Final Status (feat/company-backup-reliability)

T4 (disposable PG + browser/crash acceptance): PG 16.15 binary verified at installer/windows/.cache/postgres16 (initdb/pg_ctl --version exit 0), but no DB initialized or connected, no browser runner available. No PG/browser/crash proof can be produced; reported as unavailable, not as pass.

T5 (independent verifier): gentle-ai-verify failed twice (mvub2cg0, mvv8tn1q) with timed_out / assistant reported an error. No independent verdict exists. Do not retry or infer approval.

Commits on feat/company-backup-reliability:
- 9a8c313 T3a byte fidelity (download)
- 21208ba T2a maintenance admission/drain
- ba9c725 T2b supported-writer fencing
- 98a4626 T1 core export/catalog + fidelity
- 1a281d7 T2 journal/restore/storage/validation
- T3 UI/API present in source, no separate commit

Open blockers: real PG/browser/crash proof (T4), independent verifier (T5), ambient DB/AEX untouched, no publish/installer changes.