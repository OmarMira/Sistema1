# Bank Import Pipeline

**Status:** Stable (v0.9.0)

---

## Pipeline

```
PDF / OFX / CSV
   │
   ▼
Parser (bank-specific profile)
   │  pdfjs-dist para PDF
   │  OFX parser para OFX
   │  CSV parser para CSV
   │
   ▼
Normalization
   │  Estandariza fechas (→ ISO)
   │  Estandariza montos (→ number)
   │  Limpia descripciones
   │  Identifica header/balances
   │
   ▼
Entity Detection
   │  Busca coincidencias en EntityContext
   │  Detecta proveedores, clientes, conceptos
   │  Sin estado mutable (determinista)
   │
   ▼
Rule Engine
   │  BankRules por empresa
   │  Match por descripción, monto, entidad
   │  Orden: condiciones exactas → patrones → AI
   │
   ▼ (si no hay regla)
AI Classification
   │  Solo probabilistico cuando no hay evidencia
   │  Propone categoría + entidad
   │
   ▼
Journal Entry Generation
   │  Crea asientos contables
   │  Débito/Crédito según tipo de transacción
   │
   ▼
Reconciliation
   │  Matching contra saldo bancario
   │  Soporta ajustes y des-reconciliación
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
