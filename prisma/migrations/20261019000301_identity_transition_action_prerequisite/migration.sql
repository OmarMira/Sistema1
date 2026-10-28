-- Permit the transition audit action before migration 20261019000400 inserts it.
-- Keep existing applied migrations unchanged; the later compatibility fix remains valid.
BEGIN;
ALTER TABLE "IdentitySecurityEvent" DROP CONSTRAINT IF EXISTS "IdentitySecurityEvent_action_check";
ALTER TABLE "IdentitySecurityEvent" ADD CONSTRAINT "IdentitySecurityEvent_action_check" CHECK (action IN ('verification_issued','verification_rejected','verification_confirmed','recovery_issued','recovery_consumed','delivery_ok','delivery_failed','transition_started'));
COMMIT;
