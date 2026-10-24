# Entity relationship suggestions

In **Clasificar entidades**, suggestions describe the relationship between the displayed entity and the active company. They do not classify a debit as an expense or a credit as revenue, and they are not guaranteed accounting facts.

## User flow

1. Open **Clasificar entidades**. Each entity initially offers **Obtener sugerencia**.
2. Request a suggestion to see a proposed relationship and its explanation. Nothing is assigned at this point.
3. Use **Obtener nueva sugerencia**, directly or after discarding the proposal, to request a fresh evaluation with the previous proposal as context. The result may be the same if the evidence supports it.
4. Accept the proposal or assign the relationship manually. Only an explicit assignment saves a classification. Rule creation remains a separate opt-in.

Proposal history is separate for each entity and is retained while the dialog is open. Closing the dialog or switching companies clears that temporary history. A failed provider request displays an error and allows retrying; it does not pretend that a stored classification is a fresh AI response.

## Request contract

`POST /api/learning/suggest-role` keeps the existing automatic/local-match behavior when `manualRequest` is absent or false. Requests with `manualRequest: true` always consult the configured AI provider, bypass local-match responses and local fallbacks, and do not return an automatic-assignment signal.

The dialog sends the existing transaction evidence, plus these optional fields:

- `entityName`: the actual displayed entity name, even when `description` contains a user-provided relationship explanation.
- `previousSuggestion`: `{ "role": "ROLE_NAME", "explanation": "Previous explanation" }`, sent only after a successful proposal for that entity.

New context fields are validated and checked for prompt injection before use. Invalid context returns HTTP 400. A failed fresh AI request returns HTTP 502 (`AI_REQUEST_FAILED`); missing provider configuration returns HTTP 502 (`AI_NOT_CONFIGURED`). No classification or rule is written by this endpoint.

## Accounting guidance and language

The relationship and the accounting purpose are separate decisions. With **Obtener sugerencia**, the dialog also requests an account proposal from the active company's real, active chart of accounts.

- **Usar cuenta sugerida** selects that existing account; it does not save the entity or enable automation.
- The account selector allows choosing another existing account, even without creating a rule.
- **Crear una subcuenta** previews a child code and its parent. After entering a name, **Confirmar creación de subcuenta** explicitly creates the account through the existing `POST /api/accounts`. The child inherits the parent's account type and normal balance. This creates an account, not a classification or a rule.
- Creation failures or code conflicts leave the classification unsaved. Assignment is disabled while child creation is pending.
- Accepting the entity stores the explicitly selected account as a reference. A new suggestion clears the previous account/intent selection and automation opt-in so an obsolete proposal is not silently accepted.
- Without sufficient transaction evidence, the proposal asks what the movements represent. Enter an explanation and request **Obtener nueva sugerencia**. A name or a credit alone does not establish rental income.
- Rent proposals require a supporting excerpt from the supplied transaction samples or the user's clarification. Incoming rent uses a revenue account, outgoing rent an expense account; deposit evidence in a rent proposal or an incompatible account requires clarification. Once confirmed, a received security deposit can suggest an existing liability account with intent `OTHER`; received deposits must not be proposed as revenue or expense. This safeguard is not comprehensive accounting validation.

Manual responses add `accountGuidance: { account, intent, reason, needsClarification, question }`. The account must exist in the authenticated company's active catalog; invented or cross-company codes are not accepted. Missing or unsupported evidence yields a clarification rather than an invented account. Automatic callers retain their existing response shape.

The dialog sends `x-locale` on suggestion, assignment and account requests. The AI is instructed to explain in Spanish or English accordingly; local-match explanations and the new controls are also localized. Existing user-defined account names are preserved, not renamed or translated in storage. English remains the legacy API default when no supported locale header is sent.

## Local verification

```sh
npx vitest run --config vitest.entity-suggestions.config.ts
```

This targeted suite uses mocked persistence and providers, does not load `.env`, and does not run database setup or seeds. It covers the rendered dialog lifecycle, per-entity context, explicit acceptance, API reevaluation and compatibility with automatic callers. It does not measure the factual accuracy of a live AI provider.
