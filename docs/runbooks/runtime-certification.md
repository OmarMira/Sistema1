# Runtime Certification

## Critical Variable Certification

Before modifying, the AI **must** verify that critical runtime variables exist:

- `SESSION_SECRET` — confirm presence and valid format
- `DATABASE_URL` — confirm presence and valid format

This check certifies **presence and format only**. It is **strictly prohibited** to print, log, or display values or fragments.

If either variable is missing or malformed: **STOP** and inform.

## Runtime Certification Procedure

Before any modification that affects system execution, the following must be certified:

- `SESSION_SECRET` present and valid format
- `DATABASE_URL` present and valid format
- Prisma connected and migrations consistent
- `.data/` accessible (if applicable)
- Runtime initialized

> The absence of a critical runtime component must block any change that depends on it.

---

## Change History

### v1.0 (2026-07-16)
- Extracted from the original monolithic governance document (sections 11 and 27)
