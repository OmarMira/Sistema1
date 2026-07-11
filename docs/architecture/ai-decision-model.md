# AI Decision Model

**Status:** Stable (v0.9.0)

---

## Core principle

La IA **no contabiliza**. Solamente **propone clasificaciones** cuando el motor determinista no encuentra evidencia suficiente. La decisión final siempre es humana.

---

## Decision hierarchy

```
1. Regla explícita (BankRule)
   └── Se aplica sin consultar IA
   └── Trazabilidad: "matched by rule X"

2. Contexto histórico
   └── Misma entidad + mismo patrón en el pasado
   └── Se extrapola (determinista)
   └── Trazabilidad: "matched by history (statement Y)"

3. Entity Detection
   └── Coincidencia en EntityContext
   └── Determinista, sin estado mutable
   └── Trazabilidad: "entity detected: {name}"

4. AI propone
   └── Solo cuando 1-3 no producen resultado
   └── Propuesta probabilística
   └── Trazabilidad: "AI suggested: {category} ({confidence}%)"

5. Contador decide
   └── Acepta, rechaza o reclasifica
   └── Queda registrado como decisión final
```

---

## Data flow

```
Transaction → Rule Engine
                ├── Match found? → Apply (deterministic)
                └── No match? → AI Classification
                                   ├── Confidence > threshold? → Propose
                                   └── Low confidence? → Flag for manual
```

---

## Constraints

| Aspecto | Regla |
|---|---|
| **AI API keys** | Cifradas en DB con AES-256-GCM (`SESSION_SECRET`) |
| **Fallback** | No hay — sin AI config, no hay clasificación AI |
| **Audit trail** | Toda propuesta AI queda en `AuditLog` |
| **Override** | Contador puede sobreescribir cualquier clasificación |
| **Learning** | Overrides humanos retroalimentan el modelo |

---

## Security

- `SESSION_SECRET` es obligatorio en todos los entornos
- Sin hardcoded fallback (eliminado en security hardening)
- Mensajes de error no exponen API keys ni ciphertext
