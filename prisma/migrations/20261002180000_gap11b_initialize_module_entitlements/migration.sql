-- Gap #11B: initialize default module entitlements for existing companies (insert missing rows only)
INSERT INTO "CompanyModuleEntitlement" ("id", "companyId", "moduleKey", "enabled", "activatedAt", "deactivatedAt", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  c.id,
  v."moduleKey",
  v.enabled,
  CASE WHEN v.enabled THEN CURRENT_TIMESTAMP ELSE NULL END,
  NULL::timestamp,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Company" c
CROSS JOIN (
  VALUES
    ('accounting', true),
    ('banking', true),
    ('purchases', false),
    ('sales', false),
    ('inventory', false)
) AS v("moduleKey", enabled)
WHERE NOT EXISTS (
  SELECT 1 FROM "CompanyModuleEntitlement" e
  WHERE e."companyId" = c.id AND e."moduleKey" = v."moduleKey"
);
