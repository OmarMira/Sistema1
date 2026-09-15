-- pg_trgm is required by MemoryRepository.searchRanked() (C2 ranked search).
-- Canonical declaration of the product's PostgreSQL engine dependency.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
