# ADR-010: Bash Security Model

**Status:** Accepted (2026-07)

**Context:** OpenCode agents execute bash commands against the project filesystem. Without restrictions, an agent can run arbitrary commands — including destructive operations like `git reset --hard`, `DROP`, or `rm -rf`. The project governance (GOV-001) already defines prohibitions and protected areas, but those are policy-level: they depend on the agent respecting them. A safety-net was needed at the tool-permission layer to enforce those policies mechanically.

**Decision:** Bash commands are restricted via `opencode.json` using OpenCode's built-in permission system. The model is **deny-by-default with an explicit allowlist**:

```
"bash": {
  "*": "deny",

  "git status*": "allow",
  "git diff*": "allow",
  "git log*": "allow",
  "git show*": "allow",
  "git branch*": "allow",
  "git ls-files*": "allow",

  "npm test": "allow",
  "npm run build": "allow",
  "npm run lint": "allow",

  "npx vitest *": "allow",
  "npx tsc *": "allow",
  "npx prisma *": "allow"
}
```

Every command outside this list requires explicit user authorization at runtime.

**Consequences:**

- Read-only git operations (`status`, `diff`, `log`, `show`, `branch`, `ls-files`) are always available.
- Build/test/lint tooling (`npm`, `npx`) is available for verification.
- Destructive commands (`git reset --hard`, `git clean`, `git push --force`, `git rebase`, `DROP`, `TRUNCATE`, `rm -rf`) require explicit user approval per use.
- File/resource creation and modification routes through `operation-controller-write` instead of raw bash.
- The model is auditable from `opencode.json` — no hidden allow rules.

**Rationale:**

- Policy-only enforcement failed: the agent could ignore governance and execute destructive commands.
- Deny-by-default ensures that new/unknown commands cannot execute without review.
- The allowlist matches the project's actual pipeline: git for VCS, npm/npx for JS tooling.
- Aligns with GOV-001 sections 1 (Absolute Prohibitions) and 6 (Destructive Command Confirmation).

**Risk:** If a legitimate command is missing from the allowlist, the agent will fail noisily instead of silently proceeding. This is intentional — better to fail blocked than to fail destructively.

**Related:** GOV-001, ADR-007 (AI as Assistant), `opencode.json`
