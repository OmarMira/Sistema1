// Sprint 0 — Historical Compatibility Note
//
// This file is preserved for reference only.
// There are 0 legacy BankRule records in the database — no migration needed.
// The new engine uses the ADR-009 contract directly with no translation layer.
//
// See docs/adr/ADR-009-deterministic-rule-engine-contract.md for the full contract.
// See src/lib/rule-engine/types.ts for the TypeScript types.
//
// Legacy fields (prisma/schema.prisma:245):
//   conditionType: string        // "contains" | "equals" | "starts_with" | "ends_with" | "amount_greater" | "amount_less"
//   conditionValue: string       // free text or numeric string
//   isActive: boolean
//
// The expanded ADR-009 condition types cover all legacy operators explicitly.
// isActive is replaced by the Rule Lifecycle (draft → testing → active → deprecated → archived).
