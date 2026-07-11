# Bank Import Pipeline

**Status:** Stable (v0.9.0)

---

## Pipeline

```mermaid
flowchart TD
    A[PDF / OFX / CSV] --> B[Parser<br/>bank-specific profile]
    B --> C[Normalization<br/>fechas, montos, descripciones]
    C --> D[Entity Detection<br/>proveedor, cliente, concepto]
    D --> E{Rule Engine}
    E -->|match found| F[Journal Entry<br/>Generation]
    E -->|no match| G[AI Classification]
    G --> F
    F --> H[Reconciliation]
```

---

## Bank profiles

Cada banco tiene su perfil en `src/lib/bank-profiles/`. Definen:

- Posiciones de texto en PDF (coordenadas X/Y)
- Patrones de fechas y montos
- Formato de secciones (checks, deposits, fees)
- Reglas de parsing específicas

Soportados actualmente: **Bank of America**.

---

## Validation

- **Math check:** opening + transactions = closing balance
- Si hay mismatch: `mathValid: false`, transacciones parciales, `AuditLog` registrado
- El mismatch no bloquea la importación — se registra como warning

---

## Error handling

| Situación | Comportamiento |
|---|---|
| PDF ilegible | Error claro, sin crash |
| Mismatch matemático | Warning + `AuditLog`, importación continúa |
| Formato no soportado | Error en parseo inicial |
| Duplicados | Detectados por hash de transacción |
