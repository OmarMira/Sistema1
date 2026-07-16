# Database Changes

## Procedure

Before modifying schema or data:

- Explain what changes
- List affected tables and columns
- Identify risk of data loss or accounting reinterpretation
- Create verifiable backup
- Define rollback plan
- Test on a separate database
- Run integrity validations before and after

No migration is considered safe just because Prisma accepts it.

## Safe Rollback (data)

For database changes, the rollback plan must include:

```
Rollback Plan

- Affected tables and columns
- Migrations to revert
- Affected data (rows, records)
- Rollback SQL commands
- Data integrity revalidation steps
- Abort criteria
```

---

## Change History

### v1.0 (2026-07-16)
- Extracted from `../process/project-governance.md` section 4
- Rollback data procedure added from section 21
