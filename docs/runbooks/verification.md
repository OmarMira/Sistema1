# Verification

## Mandatory Pre-Commit Verification

Before committing, always show:

```powershell
git branch --show-current
git status --short
git diff --check
git diff --stat
git diff --cached --stat
```

Then execute and show results for:

```powershell
npx tsc --noEmit
npx vitest run --no-file-parallelism
npm run build
```

Database changes additionally require integrity tests and rollback verification.

## Mandatory Evidence

Every declaration of "done" or "ready" must be accompanied by evidence.

Examples:

```
npx tsc --noEmit
✓

npx vitest run --no-file-parallelism
1336/1336

npm run build
✓

git status --short
clean

git diff --stat
3 files changed
```

Evidence is part of the deliverable. Without it, the task is not complete.

---

## Change History

### v1.0 (2026-07-16)
- Extracted from `../process/project-governance.md` sections 8 and 14
