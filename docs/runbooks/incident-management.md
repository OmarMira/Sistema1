# Incident Management

## Incident Registry

Every time an incident occurs (e.g., lost `.env.local`, deleted branch, encryption failure, accidental file deletion, dangerous change), it **must** be recorded:

```
Incident ID:

What happened:

Root cause:

How it was detected:

How it was fixed:

What new rule prevents recurrence:

Preventive test added:
```

This turns every error into a permanent process improvement.

## Root Cause Documentation

When fixing a bug, the AI must answer:

```
What is the root cause?

What evidence confirms it?

What fix addresses it specifically?

How is the fix verified?
```

The following approach is **prohibited**:

> "Let's try this change and see if it works."

---

## Change History

### v1.0 (2026-07-16)
- Extracted from `../process/project-governance.md` sections 15 and 25
