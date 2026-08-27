# G12/F10 PRECOMMIT EVIDENCE

## Status: READY

## Gate Results

| Gate | Status | Evidence |
|------|--------|----------|
| tsc --noEmit | PASS | Zero errors |
| eslint (14 modified files) | PASS | Zero warnings/errors |
| G12 tests (37 tests) | PASS | 37/37 pass |
| Full test suite regression | PASS | No new failures (pre-existing DNS failures in suggest-role/ai-assistant unchanged) |
| import/validate untouched | PASS | Verified no diff |
| alerts.ts untouched | PASS | Verified no diff |

## Files Modified

### Error Handling (G12-1/2/4/5/6)
- `src/lib/services/closing-engine.ts` — Removed redundant try/catch
- `src/app/api/fiscal-periods/close/route.ts` — Removed try/catch, generic error
- `src/app/api/health/route.ts` — Removed NODE_ENV leak, generic catch
- `src/app/api/learning/context/route.ts` — Removed GET+POST try/catch
- `src/app/api/learning/entities/route.ts` — Removed POST try/catch
- `src/app/api/learning/pending-entities/route.ts` — Removed GET try/catch
- `src/app/api/learning/rules/route.ts` — Removed POST try/catch
- `src/app/api/learning/rules/simulate/route.ts` — Removed POST try/catch
- `src/app/api/learning/classify-entity/route.ts` — Sanitized catch, generic msgs
- `src/app/api/learning/conversational-parse/route.ts` — Removed outer try/catch
- `src/app/api/onboarding/complete/route.ts` — Removed POST try/catch
- `src/app/api/import/analyze/route.ts` — Generic error msg in per-file catch

### Centralized Secret Redaction (G12-3)
- `src/lib/logger.ts` — Added `redactValue()` with recursive object/array traversal, SENSITIVE_KEYS regex, Slack webhook token masking, long hex string detection, depth truncation at 8 levels

### Logging Sanitization (G12-8/9)
- `src/lib/ai-config.ts` — Removed `keyPrefix: apiKey.slice(0,6)` from log, sanitized integrity check detail msgs
- `src/lib/dashboard/export-utils.ts` — Replaced full payload log with hash-only log

### Tests
- `src/__tests__/g12-security.test.ts` — 37 tests covering all 9 G12 points

## G12 Points Coverage

1. **closing-engine generic errors** — ValidationError thrown, not raw Error
2. **API route error sanitization** — 11 routes: no error.message in responses
3. **Centralized secret redaction** — logger.ts redacts apiKey, password, token, secret, webhookUrl, accessToken, refreshToken, long hex strings
4. **import/analyze generic errors** — Static Spanish msg, no err.message leak
5. **onboarding/complete generic errors** — No try/catch, apiHandler handles
6. **learning routes generic errors** — 7 routes sanitized
7. **Health endpoint no env leak** — NODE_ENV removed from response
8. **ai-config no key prefix log** — keyPrefix removed from Decrypted OK log
9. **export-utils no payload log** — Full payload replaced with hash-only

## Not Modified (by design)
- `src/app/api/learning/import/validate/route.ts` — Explicitly excluded per scope
- `src/lib/services/alerts.ts` — Explicitly excluded per scope
