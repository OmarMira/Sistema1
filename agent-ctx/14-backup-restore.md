# Task 14 - Backup and Restore API System

## Work Summary

Built a complete backup and restore system for the AccountExpress Next-Gen CRM with file-based storage, full API routes, and an integrated frontend UI.

## Files Created

### Backend - Utility Library
- **`/src/lib/backup.ts`** - Core backup engine with functions:
  - `createBackup(companyId)` - Extracts ALL company data from 11 tables, serializes as JSON with metadata/manifest, saves to disk, updates manifest file, returns base64-encoded backup
  - `listBackups(companyId)` - Reads manifest file, filters by company, returns sorted backup list
  - `getBackupFile(filename)` - Reads a specific backup JSON file with path traversal protection
  - `deleteBackup(filename)` - Deletes a backup file and updates the manifest
  - `validateBackup(backupData)` - Validates backup structure (manifest, required sections, company data)
  - `restoreBackup(companyId, backupData)` - Full transactional restore: deletes existing data in dependency order, re-inserts with ID remapping for foreign keys (parentId, glAccountId, statementId, entryId)

### Backend - API Routes
- **`/src/app/api/backup/route.ts`** - 3 endpoints:
  - `POST /api/backup` - Create backup (auth check, membership verification, returns base64 data)
  - `GET /api/backup?companyId=xxx` - List backups for company
  - `DELETE /api/backup` - Delete a specific backup file
- **`/src/app/api/backup/restore/route.ts`** - Restore endpoint:
  - `POST /api/backup/restore` - Accepts both FormData (file upload) and JSON (base64 data), validates, restores with atomicity
- **`/src/app/api/backup/[filename]/route.ts`** - Download endpoint:
  - `GET /api/backup/[filename]?companyId=xxx` - Returns backup as base64 JSON

### Frontend - BackupPage Component
- **`/src/components/spa/BackupPage.tsx`** - Full backup/restore UI with:
  - Create backup button with auto-download
  - Restore from file with drag-and-drop zone + file picker
  - Restore progress overlay with backdrop blur
  - Backup history list with download/delete actions per item
  - Confirmation dialogs for restore and delete
  - Persistent database info banner
  - Record count badges per backup
  - Toast notifications for all actions
  - Responsive layout (2-col on desktop, stacked on mobile)
  - Framer Motion animations

### Frontend - Integration
- **`/src/store/auth-store.ts`** - Added `'backup'` to `ViewName` union type
- **`/src/components/spa/AppShell.tsx`** - Added BackupPage import, nav item with DatabaseBackup icon, route handler, and viewKeyMap entry

### i18n Updates
- **`/src/i18n/locales/en.ts`** - Added 14 new backup translation keys
- **`/src/i18n/locales/es.ts`** - Added 14 matching Spanish translation keys

## Technical Details

### Backup Storage
- Directory: `/home/z/my-project/db/backups/`
- File naming: `{companyId}_{ISO-timestamp}.json`
- Manifest: `/home/z/my-project/db/backups/manifest.json` tracks all backups with metadata

### Data Coverage (11 tables)
Company, GlAccount, BankAccount, BankStatement, BankTransaction, BankRule, JournalEntry, JournalLine, FiscalPeriod, CompanyMember, User

### Restore Strategy
- Wrapped in Prisma `$transaction` for atomicity
- Deletes in reverse dependency order to avoid foreign key violations
- Re-inserts with two-pass GL account creation (parent accounts first, then children)
- ID remapping maps old IDs to new IDs for: parentId, glAccountId, statementId, entryId

### Security
- Session-based authentication on all endpoints
- Company membership verification (access control)
- Path traversal prevention on file downloads
- Directory existence auto-creation
