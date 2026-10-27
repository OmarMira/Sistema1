# PDF import recovery

Known PDF layouts use the existing `BankProfile` pipeline. They do not require an AI request for every document.

## Profile precedence

- The loader validates the structural definitions shipped with the application and makes them available as a read-only fallback.
- A database definition with the same `bankId` takes precedence. An explicitly inactive definition suppresses that packaged fallback.
- The parser must match the document's fingerprints before using a profile. An unknown bank is not assigned the packaged bank by default.
- Learned profiles continue to use the existing database persistence and cache invalidation mechanism. Database failures are not treated as a missing profile store.

The registry currently includes the existing `boa-standard.json` definition. This does not imply support for every bank or every Bank of America layout. New layouts still need validated structural definitions; their discovery may require the configured AI provider.

## Safety and limitations

The fallback does not create accounts, import transactions, change credentials or write profiles to the database. Redundant full-file-hash profile hooks were removed from the working import/analyze flows; their unused table was not dropped. CSV and OFX parsing are unchanged. Accepting an Excel extension is not proof of an implemented spreadsheet parser.

## Offline verification

```sh
node node_modules/vitest/vitest.mjs run --config tests/pdf-import-offline.config.ts
node node_modules/typescript/bin/tsc --noEmit --incremental false --pretty false
```

The isolated configuration excludes the normal database bootstrap and forces an unreachable database URL. Profile/parser tests mock storage and discovery. Synthetic statements assert dates, descriptions, signed amounts and balance reconciliation without external calls. Personal PDF examples must remain outside the repository and may only be read locally for explicitly authorized diagnostics.
