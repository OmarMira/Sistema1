# Kernel Maintenance Workflow

**Document ID:** PRO-003
**Version:** 1.0
**Status:** Stable
**Last Updated:** 2026-07-30

---

## Problem

El Operation Controller tiene Protected Zones que impiden su auto-modificación mediante `operation-controller-write`. Esto es correcto por diseño. Pero cuando el kernel necesita una modificación legítima (bugfix, mejora, extensión), **no existe un canal oficial para hacerlo sin debilitar el modelo de seguridad**.

---

## Design

```
              ┌────────────────────────┐
              │   Maintenance Trigger   │
              │  (bugfix / improvement) │
              └──────────┬─────────────┘
                         │
                         ▼
              ┌────────────────────────┐
              │ 1. Document & Propose   │
              │    (ADR / INC / Issue)  │
              └──────────┬─────────────┘
                         │
                         ▼
              ┌────────────────────────┐
              │ 2. Authorize           │◄──── Human
              │    "Maintenance Mode"  │      Sign-Off
              └──────────┬─────────────┘
                         │
                         ▼
              ┌────────────────────────┐
              │ 3. Apply via External  │
              │    Channel (human dev  │
              │    + agent provides    │
              │    exact code)         │
              └──────────┬─────────────┘
                         │
                         ▼
              ┌────────────────────────┐
              │ 4. Verify              │
              │    (tsc + tests +      │
              │     security review)   │
              └──────────┬─────────────┘
                         │
                         ▼
              ┌────────────────────────┐
              │ 5. Close & Audit       │
              │    (exit maintenance)  │
              └────────────────────────┘
```

---

## Step-by-Step

### 1. Document & Propose

Before touching any protected file, the agent **must** produce a written artifact:

- **ADR** — if the change involves an architectural decision
- **INC** — if the change fixes a bug or incident
- **Spec** — if the change adds a new capability

The proposal must include:

```
Component:
Current behavior:
Desired behavior:
Why it requires kernel modification:
Verification plan:
Rollback plan:
```

### 2. Authorize Maintenance Mode

The human must explicitly authorize the maintenance window. Authorization includes:

- **Scope**: exact list of files to modify (no extras)
- **Expected impact**: what changes behavior and how
- **Channel**: which external mechanism will apply the changes
- **Duration**: when maintenance mode begins and ends

> "Kernel maintenance authorized for: `src/internal/operation-controller/resources/file-resource.ts`, `tests/operation-controller/file-resource.test.ts`. Channel: direct human edit with code provided by agent. Duration: single commit."

### 3. Apply via External Channel

Because the Operation Controller cannot modify itself, **the write must come from outside the OC**:

| Channel | How | When |
|---------|-----|------|
| **Human direct edit** | The agent provides the exact file contents; the human copies them into the files using their editor (VS Code, etc.) | Default — always available, lowest risk |
| **Maintenance branch with temporary tool** | IF the platform allows fine-grained tool grants, the human may enable a write mechanism for the specific scope. This is **not** a change to `opencode.json` — it's a session-scoped override | Only when human direct edit is impractical |

**Critical rule**: The agent must provide the EXACT content to be written. Line-by-line diffs. No room for interpretation.

**Agent provides**:
```
File: src/internal/operation-controller/resources/file-resource.ts
[exact content or diff]

File: tests/operation-controller/file-resource.test.ts
[exact content or diff]
```

**Human applies** using editor or git tooling.

### 4. Verify

After the changes are applied by the human:

1. **TypeScript**: `npx tsc --noEmit` — must pass
2. **Lint**: `npm run lint` — must pass
3. **Tests**: `npx vitest run operation-controller` — must pass
4. **Security review**: confirm that Protected Zones are intact and no rules were weakened
5. **Evidence**: show `git diff --stat` of the changes

The agent runs all verification steps.

### 5. Close & Audit

1. The human commits the changes with a conventional commit message (e.g., `fix: create missing parent dirs in FileResource`)
2. The human pushes
3. The agent updates any related documentation (ADR, INC, spec) with the implemented solution
4. The agent confirms `git status` is clean and all verification still passes
5. Maintenance Mode ends

---

## What Maintenance Mode is NOT

| Incorrect | Correct |
|-----------|---------|
| "Habilitame `edit: allow` para trabajar" | "Acá está el código exacto; aplicálo y corro verificación" |
| "Desactivá temporalmente la Protected Zone" | "Usá el canal externo (tu editor) para escribir el archivo" |
| "Permitime modificar `opencode.json`" | "El opencode.json no se toca durante mantenimiento del kernel" |

---

## Audit Log

Every kernel maintenance event must be logged in `docs/history/maintenance-log.md`:

```
## 2026-07-30: FileResource mkdir-p support
Trigger: INC-001 — operation-controller-write fails on missing parent dir
Files changed: file-resource.ts, file-resource.test.ts
Channel: human direct edit
Authorized by: <user>
Verification: tsc ✓, lint ✓, tests ✓
Commit: a0f21f374eb756b34279f1d4062ebdc4fff8b329
```

---

## Relationship to Other Documents

| Document | Role |
|----------|------|
| `change-lifecycle.md` | General change procedure (non-kernel) |
| `governance.md` | Policy rules (section 2: Protected Areas) |
| `task-closure-protocol.md` | Closing tasks after changes |
| `protected-zones.ts` | Technical implementation of protection |
| `incident-management.md` | Incident documentation format |

---

## Change History

### v1.0 (2026-07-30)
- Initial design after discovering the gap: Operation Controller's Protected Zones prevent self-modification, but no maintenance workflow existed for authorized kernel changes.
