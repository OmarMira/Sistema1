-- T14/S9 follow-up: allow prefixed rate-limit subjects.
--
-- IdentityRateLimit.subject was constrained to a bare 64-hex digest
-- (20261019000100_identity_infrastructure). The portable recovery flow writes
-- `bootstrap-recovery:<digest>` subjects (src/lib/backup-recovery-auth.ts),
-- which 23514-violated IdentityRateLimit_subject_check on the first restore
-- attempt. This migration is additive: it only widens the check constraint to
-- accept lowercase prefixed kinds (`<kind>:<64-hex digest>`); no data is read,
-- changed or deleted. Existing bare-digest subjects keep matching.

ALTER TABLE "IdentityRateLimit" DROP CONSTRAINT "IdentityRateLimit_subject_check";

ALTER TABLE "IdentityRateLimit" ADD CONSTRAINT "IdentityRateLimit_subject_check"
  CHECK ("subject" ~ '^([a-z0-9-]{1,64}:)?[a-f0-9]{64}$');
