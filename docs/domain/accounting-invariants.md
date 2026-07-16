# Accounting Domain Invariants

> Contratos vivos del dominio contable. No son decisiones históricas (ADR); son reglas permanentemente vigentes que ningún cambio puede violar.

**Document ID:** INV-001
**Version:** 1.0
**Status:** Stable
**Last Updated:** 2026-07-16

---

## Functional Invariants (accounting correctness)

The following contracts are **never** to be broken:

- Double-entry always balanced
- Amounts always in cents (integer precision)
- Audit trail immutable (never deleted or altered)
- Closed periods never modified
- Reconciled transactions never reclassified
- Ignored transactions never reclassified
- Transactions with journal entries never modified
- Manual classifications never overwritten
- Deterministic results for the same input
- Orphan records never produced

## Technical Invariants (infrastructure and safety)

- Audit IDs never reused
- Migration history never altered after applied
- Encryption keys never changed without re-encrypting existing data
- Runtime secrets never stored in the repository
- Backups never stored alongside source code
- Database credentials never hardcoded

After any accounting or banking change, always verify the above.

Every Sprint must explicitly declare whether it affects any of these invariants.

---

## Accounting Data Protection

In addition to the invariants above, no process may:

- Alter historical balances
- Reinterpret posted transactions
- Regenerate audit history
- Modify closed periods

Unless explicitly authorized.

---

## Data Preservation

> No modification may reinterpret historical data without authorization.

Examples of prohibited reinterpretation:

- Reclassifying old transactions
- Recalculating historical balances
- Regenerating audit records
- Rebuilding journal entries

Historical data integrity is protected.

---

## Change History

### v1.0 (2026-07-16)
- Extracted from the original monolithic governance document (sections 5, 6, and 22)
- Functional invariants, technical invariants, data protection, and data preservation merged into single SSOT
