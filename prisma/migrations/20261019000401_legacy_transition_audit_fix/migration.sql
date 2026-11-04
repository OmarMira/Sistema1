-- Fix: extend allowed actions for T6 audit (transition_started)
ALTER TABLE "IdentitySecurityEvent" DROP CONSTRAINT IF EXISTS "IdentitySecurityEvent_action_check";
ALTER TABLE "IdentitySecurityEvent" ADD CONSTRAINT "IdentitySecurityEvent_action_check" CHECK (action IN ('verification_issued','verification_rejected','verification_confirmed','recovery_issued','recovery_consumed','delivery_ok','delivery_failed','transition_started'));
