-- Recovery portable actions were never added to IdentitySecurityEvent's
-- closed action list (20261019000301/20261019000401 define only the identity
-- module's eight actions). Every recovery recordEvent therefore fails with
-- 23514 and masks the real rejection reason (T14 follow-up, L26).
-- Additive: widens the check to include the six recovery actions; no data is
-- read, changed or deleted.

ALTER TABLE "IdentitySecurityEvent" DROP CONSTRAINT "IdentitySecurityEvent_action_check";

ALTER TABLE "IdentitySecurityEvent" ADD CONSTRAINT "IdentitySecurityEvent_action_check" CHECK (action IN (
  'verification_issued','verification_rejected','verification_confirmed',
  'recovery_issued','recovery_consumed','delivery_ok','delivery_failed',
  'transition_started',
  'challenge_issued','challenge_rejected','challenge_delivery_failed',
  'challenge_consumed','restore_committed','restore_failed'
));
