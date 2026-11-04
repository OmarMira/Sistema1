-- S6 (Wave 5): one-time re-hash of legacy BankTransaction."importHash" values.
--
-- WHY
-- The bank-row dedupe hash used to include the STATEMENT MONTH, so the same row
-- hashed differently under a different statement range and was silently
-- imported twice (src/lib/accounting/import-hash.ts: `generateLegacyImportHash`
-- is kept only as the compatibility anchor). Rows written by older builds still
-- carry that month-scoped value in "importHash", so the import pipeline looks up
-- BOTH hash shapes (content + legacy anchor): existing rows keep deduping inside
-- their original statement month, but a re-import under a DIFFERENT month is not
-- recognized.
--
-- WHAT
-- Recompute every stored hash as the CONTENT hash — `generateImportHash` — from
-- the row's OWN fields (company, account number, transaction date, amount,
-- description, reference). The content hash is independent of the statement
-- range, so after this migration the same stored row is found again whatever
-- month the next statement covers. The legacy anchor lookup in
-- src/lib/services/import.service.ts stays in place (harmless once nothing is
-- stored that way) so an instance that restores an old backup keeps deduping.
--
-- NORMALIZATION — must stay byte-identical to import-hash.ts:
--   raw = companyId | accountNumber | txDate | amount.toFixed(2)
--         | normalizeText(description) | normalizeText(reference ?? '')
--   normalizeText(v) = v.trim().replace(/\s+/g, ' ').toLowerCase()
-- so: collapse whitespace runs, trim, lowercase. `txDate` is the UTC calendar
-- day (`toISOString().split('T')[0]`) of a column stored as timestamp(3) UTC.
-- Known (documented) divergence, ASCII/Latin inputs are identical: JS `\s`
-- includes U+00A0 and `String#trim` strips more Unicode space characters than
-- POSIX `[[:space:]]`, and Postgres `lower()` follows the database collation
-- while JS uses Unicode simple case mapping. Bank descriptions in production are
-- ASCII/Latin-1 text, where the two agree exactly.
--
-- SAFETY / IDEMPOTENCY
--  * Rows whose stored value already equals their content hash are skipped, so
--    re-running this file is a no-op.
--  * Two legacy rows may be the SAME row imported under two statement months.
--    Rewriting both would collide on the unique index ("BankTransaction_importHash_key"),
--    so a row is left untouched when its content hash is already stored on
--    another row. Nothing is lost: the duplicate stays dedupable through the
--    hash it already holds.
--  * A row without a resolvable company (no statement → account → company) is
--    skipped: the content hash needs the tenant key.
--
-- Single statement on purpose: test runners apply this file through
-- `$executeRawUnsafe`, which refuses multi-statement scripts (same constraint as
-- 20261107000000_journal_line_checks).
WITH normalized AS (
  SELECT
    bt."id" AS id,
    COALESCE(bt."companyId", ba."companyId") AS company_id,
    CASE
      WHEN ba."accountNo" IS NULL OR ba."accountNo" = '' THEN 'unknown'
      ELSE ba."accountNo"
    END AS account_number,
    to_char(bt."date", 'YYYY-MM-DD') AS tx_date,
    to_char(bt."amount", 'FM999999999999999999999999990.00') AS amount,
    lower(btrim(regexp_replace(bt."description", '\s+', ' ', 'g'))) AS description,
    lower(btrim(regexp_replace(COALESCE(bt."reference", ''), '\s+', ' ', 'g'))) AS reference
  FROM "BankTransaction" bt
  JOIN "BankStatement" bs ON bs."id" = bt."statementId"
  JOIN "BankAccount" ba ON ba."id" = bs."bankAccountId"
  WHERE bt."importHash" IS NOT NULL
),
hashed AS (
  SELECT
    n.id AS id,
    encode(
      sha256(convert_to(
        concat_ws(
          '|',
          n.company_id,
          n.account_number,
          n.tx_date,
          n.amount,
          COALESCE(n.description, ''),
          COALESCE(n.reference, '')
        ),
        'UTF8'
      )),
      'hex'
    ) AS content_hash
  FROM normalized n
  WHERE n.company_id IS NOT NULL
),
candidate AS (
  SELECT h.id AS id, h.content_hash AS content_hash
  FROM hashed h
  JOIN "BankTransaction" bt ON bt."id" = h.id
  WHERE bt."importHash" <> h.content_hash
    AND NOT EXISTS (
      SELECT 1 FROM "BankTransaction" other WHERE other."importHash" = h.content_hash
    )
),
rehash AS (
  -- DISTINCT ON: two legacy rows can share the same content (the duplicate a
  -- month-scoped hash allowed). Rewriting both would collide on the unique
  -- index, so exactly one row per content hash is re-hashed (lowest id wins);
  -- the twin keeps its existing value and stays dedupable through it.
  SELECT DISTINCT ON (candidate.content_hash) candidate.id AS id, candidate.content_hash AS content_hash
  FROM candidate
  ORDER BY candidate.content_hash, candidate.id
)
UPDATE "BankTransaction" bt
SET "importHash" = r.content_hash,
    "updatedAt" = now()
FROM rehash r
WHERE bt."id" = r.id;
