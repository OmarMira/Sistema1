# Backup download fidelity

`BackupTab` and `BackupPage` use `src/lib/backup-download.ts` for both creation
and history downloads. The JSON/base64 API contract is unchanged. Decoded base64
is a byte sequence: it must become a `Uint8Array` before constructing the Blob.
Passing the binary string directly to Blob re-encodes its bytes and corrupts
UTF-8 content such as `Compañía Ñ`, `€`, Chinese text and emoji.

The helper preserves original bytes, whitespace, filenames and the JSON MIME
type. It removes the temporary anchor and releases the object URL on the next
event-loop turn, including when the click throws. Starting a download is not
proof that the user saved the file.

## Isolated verification

```sh
node node_modules/vitest/vitest.mjs run --config vitest.company-backup.config.mts --configLoader native tests/backup-company/download.test.ts
```

The configuration disables environment-file loading and application database
setup/seed hooks. Six tests use Node's real Blob and a mock DOM to cover ASCII,
Unicode byte equality/size, filename/lifecycle, click failure cleanup and invalid
or missing transport payloads. They do not prove browser download delivery,
PostgreSQL recovery, tenant isolation or successful restoration.
