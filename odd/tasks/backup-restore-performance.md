# Backup restore performance and remaining recovery defects
Objective: complete the remaining backup fixes without weakening current recovery guarantees. Branch: perf/restore-batch-inserts.
Delivery: ask-on-risk, separate work-unit commits; first unit forecast ~180 authored lines. Runner: isolated Vitest recovery suite and explicit disposable PostgreSQL perf runner.

## Specs
S1. User: "empeza entonces y vamos a tratar de solucionar todo asi no queda nada pendiente". Scope: the previously discussed backup DELETE isolation defect, restore performance, and current-contract test coverage. No recovery redesign, operator-data mutation, or security relaxation.
S2. User: "volve a hacer el analisis, porque no puede ser que no podamos solucionar esto, solo analizalo y decime que esta pasando y como lo solucionamos". That analysis-only pause was subsequently lifted by "dale continua" following the proposal to resume internal measurements and incremental changes without touching real data.
S3. User: "dale continua". Resume the proposed sequence: real internal phase measurements, equivalent indexed validation, bounded insertion batches in one transaction, conditional reduction of unnecessary catalog/reads, then a measured finite deadline if needed. Preserve safety-before-mutation, both restore doors, identity mapping, history and atomic rollback. Checks use disposable data only; never infer insertion cost from residual subtraction.

## Tasks
T1 | S1 | inline | pending delivery verification | DELETE isolation change already published as PR #124; current CI/review not checked here.
T2 | S2-S3 | inline (understood harness correction, no writer trigger) | done | Actual in-call spans and verified post-commit counts; job-28 TypeScript exit 0 and real PG 1000-asientos probe passed; commit recorded in next log entry.
T3 | S3 | inline | pending | Optimize repeated validation searches without weakening admission; commit pending.
T4 | S3 | inline | in_progress | First batch only JournalEntry and JournalLine (measured dominant SQL calls); leave other models and self-references unchanged. Bounded chunks with no duplicate skipping and real PG rollback proof; Risk items 1,3 (replacement of persisted data and shared restore engine); commit pending.
T5 | S3 | inline | pending | Re-measure and address only demonstrated remaining bottlenecks; deadline/catalog/global reads decisions depend on evidence; commit pending.
T6 | S1-S3 | inline plus independent verifier for data/guard changes | pending | Current-contract coverage audit, final functional checks, independent integrity verification and native review when applicable; commit pending.

## Log
L1. Original authorization verbatim: "empeza entonces y vamos a tratar de solucionar todo asi no queda nada pendiente".
L2. Read-only correction verbatim: "volve a hacer el analisis, porque no puede ser que no podamos solucionar esto, solo analizalo y decime que esta pasando y como lo solucionamos".
L3. Resume authorization verbatim: "dale continua".
L4. Existing benchmark committed at 6219ee3. Standalone validate/publish times were incorrectly subtracted from a separate restore run; residual does not identify inserts. Failed runs do not prove capacity or linear throughput. Payload row counts were not verified persisted counts. Old total results remain historical evidence, not phase evidence.
L5. Prior batching worker failed network; inspected status has no production change. No active/uncertain child remains. Current baseline preserves tracked opencode.json modification and unrelated untracked .checks files and malformed filename; never stage them.
L6. T2 uses test-only wrappers around real module calls and transaction delegates, not production timing hooks. No timeout/isolation/validation or restore behavior changes. Actual write calls measure successful/failed round trips, not server-only CPU. Span nesting must be labelled, never summed as exclusive buckets. Test runner failures must retain true exit codes.
