# Engram Protocol

## Availability Check

Before starting **any task that modifies** code, documentation, configuration, database, or Git, the AI must verify Engram is available.

If Engram is **not available**:

- The AI **must** inform the user immediately.
- Read-only tasks (inspecting, reading, searching) are **not blocked**.
- Modification tasks **must not** start without explicit user authorization.
- The AI **must not** claim that memory was saved or retrieved.
- The AI **must not** skip the notification.

If Engram **is** available:

- Save root cause of each incident
- Save which rule would have prevented it
- Save affected files
- Save authorized/prohibited commands
- Save architectural decisions
- Save validations performed

---

## Change History

### v1.0 (2026-07-16)
- Extracted from `docs/process/project-governance.md` section 9
