# AccountExpress

CRM contable y conciliación bancaria para empresas US. Importa extractos bancarios, clasifica transacciones con reglas deterministas e IA, y gestiona el ciclo contable completo.

---

## Why AccountExpress?

Los ERPs contables tradicionales son pesados de configurar, opacos en sus decisiones y difíciles de auditar. AccountExpress está diseñado con el enfoque inverso: **reglas deterministas, IA explicable, auditoría completa y configuración externalizada**.

---

## Quick start

```bash
bun install
cp .env.example .env              # Editar DATABASE_URL, SESSION_SECRET
bun run db:generate && bun run db:migrate
bun run dev                        # http://localhost:3000
bun run test                       # 1014 tests
```

---

## Project philosophy

| Principio | Significado |
|---|---|
| **Local First** | Sin dependencia de cloud para operación core |
| **Deterministic before AI** | Reglas explícitas primero, AI solo como fallback |
| **Evidence over assumptions** | Toda decisión se respalda con datos |
| **Zero hardcode** | Toda configuración externalizada (`rules/`) |
| **AI proposes, accountant decides** | La IA asiste; jamás posee decisiones contables |
| **Everything auditable** | Pista de auditoría encadenada con hashes |

---

## Domain flow

```
Company → Fiscal Period → Bank Account → Bank Statement
    → Bank Transactions → Entity Detection → Bank Rules
    → Journal Entries → General Ledger → Reports
```

Entidades principales: `Company` con sus `FiscalPeriod`, `GlAccount` (plan de cuentas), `BankAccount`, `BankStatement`, `BankTransaction`, `BankRule`, `JournalEntry` y `JournalLine`.

---

## Architecture (high-level)

```
Browser → React SPA → API Routes → Services
    → Decision Engine (reglas → AI) → Prisma → PostgreSQL
```

---

## AI decision model

La IA **no contabiliza**. Solo propone cuando el motor determinista no tiene evidencia suficiente.

```
1. Regla explícita       → determinista
2. Contexto histórico    → determinista
3. Entity detection      → determinista
4. Sin evidencia         → AI propone (probabilístico)
5. Contador decide       → decisión humana final
```

---

## Documentación

| Tema | Dónde empezar |
|---|---|
| Arquitectura completa | `docs/architecture/overview.md` |
| Pipeline bancario | `docs/architecture/bank-import.md` |
| Modelo de IA | `docs/architecture/ai-decision-model.md` |
| Motor de reglas (draft) | `docs/architecture/rule-engine.md` |
| Nuevo desarrollador | `docs/getting-started/new-developer.md` |
| ADRs | `docs/adr/` |
| Principios de ingeniería | `docs/process/engineering-principles.md` |
| v0.9.0 release | `docs/releases/v0.9.0.md` |

### Orden de lectura sugerido

```
README → overview → engineering-principles
    → bank-import → ai-decision-model → rule-engine → ADRs
```
