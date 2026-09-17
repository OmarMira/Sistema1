-- JH2: versioned, per-company serialized journal hash chain.
-- Forward-only. Safe for existing databases:
--   * historical hash values are never rewritten;
--   * hashVersion is NULL for all existing rows (legacy = unknown/uncertifiable,
--     never inferred as v2);
--   * no chain-head rows are created from historical data (chains append forward).

ALTER TABLE "JournalEntry" ADD COLUMN "hashVersion" TEXT;

CREATE TABLE "JournalChainHead" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "lastHash" TEXT,
    "lastEntryId" TEXT,

    CONSTRAINT "JournalChainHead_pkey" PRIMARY KEY ("id")
);

-- One head row max per company (serialization anchor).
CREATE UNIQUE INDEX "JournalChainHead_companyId_key" ON "JournalChainHead"("companyId");

ALTER TABLE "JournalChainHead" ADD CONSTRAINT "JournalChainHead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "JournalChainHead_lastEntryId_idx" ON "JournalChainHead"("lastEntryId");
