# Runtime vs Source Data Policy

**Document ID:** RDP-001
**Version:** 1.0
**Status:** Stable
**Last Updated:** 2026-07-16

---

## Policy

Runtime data:

> Never delete.
> Never version.
> Never regenerate.
> Never move.

Without explicit authorization.

## Scope

Includes:

- `.data/`
- `.env.local`
- Secrets and keys
- Runtime logs
- User configuration

## Change History

### v1.0 (2026-07-16)
- Extracted from `docs/process/project-governance.md` section 23
