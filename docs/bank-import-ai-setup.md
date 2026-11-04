# Configure AI without losing a pending bank import

PDF format learning uses the installation's saved AI provider, API key and exact model. Recognized formats continue to parse directly; AI is not a prerequisite for every import.

## When setup is required

1. Select files and click Import.
2. If PDF learning needs missing or unusable settings, the import pauses before that file's financial records are created.
3. A platform administrator sees the existing AI configurator inside the import page. Other users are asked to contact their administrator.
4. Save the configuration or cancel. Selected files stay in memory while the import page remains mounted.
5. After saving, click Import explicitly to retry. Saving never resumes validation or imports automatically.

A page reload, navigation away or closing the application discards the temporary file selection. It is not stored in browser storage. This flow does not add a transaction preview: the existing Import action still starts the import, and the result dialog describes committed records.

## Failure meanings

| Code | Meaning |
| --- | --- |
| `AI_CONFIG_MISSING` | No saved or supported fallback configuration exists. |
| `AI_CONFIG_UNAVAILABLE` | The configuration could not be read or decrypted. |
| `AI_PROVIDER_RECONFIGURATION_REQUIRED` | Select and save a permitted provider. |
| `AI_PROVIDER_UNAVAILABLE` | The provider request failed; review connectivity, credentials, quota and model availability. |
| `AI_PROFILE_GENERATION_FAILED` | A valid bank-reading profile could not be produced. |

These errors are not empty statements or account-holder mismatches. Provider response bodies, keys and document prompts are not included in the error. Requests use canonical provider destinations, reject redirects and have a timeout. OpenAI-compatible endpoints and Anthropic's native Messages protocol have distinct request formats.

### Structured-response contract and safe diagnostics

OpenRouter requests explicitly enable `response_format: { type: 'json_object' }` and `provider: { require_parameters: true }`. This lets its free router filter for JSON-capable providers without replacing the saved model. OpenRouter's output allowance is capped at 4096 tokens (including any reasoning); other provider protocols retain their existing 1500-token allowance. First-format learning has a bounded 60-second request timeout. These limits improve the request contract; they do not guarantee provider availability or accuracy. A provider usage limit cannot be removed by the local PDF parser. Paid-model usage remains charged by the selected provider.

Optional API `details.reason` distinguishes `credentials_rejected` (HTTP 401), `credits_required` (402), `rate_limited` (429), `provider_rejected`, `timeout`, `empty_response` and `response_truncated`. `details.providerStatus` carries only the upstream HTTP status. Top-level error codes and HTTP 503 remain unchanged. No upstream error text, reasoning or document content is returned. Empty or truncated final output is rejected; reasoning is never used as a bank profile. There is no automatic retry or model fallback. The import UI presents the known reasons with localized messages. After a provider/profile failure, administrators can select **Review AI configuration** inside the import page; other users receive administrator guidance. Opening/cancelling/saving this dialog retains the selected files while the page stays mounted. Saving does not retry parsing or import automatically.

Primary references: [OpenRouter response parameters](https://openrouter.ai/docs/api/reference/parameters), [free-router capability selection](https://openrouter.ai/docs/guides/routing/routers/free-router), and [reasoning-token limits](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens).

## Scope and limits

No SMTP credentials, registration settings, accounting guards, database installation, Excel or OCR support are changed here. AI processing can send necessary statement content to the selected external provider; local database storage is not a promise that document content never leaves the machine. AI-generated formats still require validation, and no universal bank/PDF accuracy is claimed.

Multi-file imports remain sequential, not batch-atomic: an earlier file may already be imported when a later one fails. The pause applies to the failed file, not a rollback of previous files.

## Verification status

The isolated regression run passed 165 cases; three failures were incorrect local-corpus filenames in the new test, not parser failures. After correcting those references, the complete corpus test passed 12/12 (302 transactions), with AI, network and database writes blocked. This optional local corpus runs only with `RUN_BANK_PDF_CORPUS=1`; customer documents are not a distributed dependency. Shared configuration differential checks passed 5/5 and the final TypeScript check exited successfully.

A later, explicitly authorized diagnostic made exactly two real OpenRouter/free requests: a neutral prompt returned HTTP 200 with text; an invented statement returned HTTP 200 without usable final text. No real PDF or personal data was sent, and no profile, financial record or configuration was written. The exact cause of the empty answer is unproven; reasoning-budget exhaustion was not measured. Both original requests are consumed. A separately authorized single corrected request later returned HTTP 429 (usage/rate limit), with no text or generated profile. That new grant is also consumed. No request was retried. This demonstrates a provider limit for the later attempt, not the cause of the original empty HTTP 200, and does not establish a successful corrected live reading.

The response-contract correction observed eight backend RED assertions and fourteen passes, then GREEN 22/22. The UI worker initially failed to start (worker timeout), without executing the UI tests. The owner subsequently authorized one fresh local attempt: RED two expected failures/thirteen passes, then UI correction GREEN 15/15, including provider-error configuration access, reason-specific explanations, role restrictions, File retention and explicit retry. The initial failure remains recorded. Final TypeScript passed. The subsequent backend regression command exited 1: four files/46 tests passed, but `tests/pdf-parser-fail-graceful.test.ts` requires a disposable database and was stopped by Prisma's test-safety guard before executing tests. Including it in the no-DB runner was a test-selection error; no development database, global setup, guard bypass or retry was used. TypeScript passed. Protected sources and private environment size/mtime remain unchanged. These partial results are not a complete regression approval.

Live imports and the database-dependent integration suites were not executed. The independent verifier returned no final report, and native assessment could not form a candidate from the undeclared untracked scope. Neither is an approval. Final security acceptance remains pending; see `odd/tasks/bank-import-ai-setup.md`.
