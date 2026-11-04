-- T6: Phase B controlled transition. Marks all existing verified users as legacy (no forced block).
-- Only applies when transition is authorized; does not change existing data except assigning the persistent flag.
UPDATE "User" SET "legacyUser" = true WHERE "emailVerifiedAt" IS NOT NULL AND "legacyUser" = false;
INSERT INTO "IdentitySecurityEvent" (id, action, subject, "createdAt") VALUES (gen_random_uuid()::uuid, 'transition_started', 'aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899', CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING;
