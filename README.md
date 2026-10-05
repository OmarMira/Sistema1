# AccountExpress (Sistema1)

Sistema contable / ERP con conciliación bancaria y motor de conocimiento para empresas US. Importa extractos bancarios, clasifica transacciones con reglas deterministas e IA explicable, y gestiona el ciclo contable completo — con pista de auditoría encadenada.

**Estado actual:** núcleo técnico **certificado** — cadena de 12 Gaps cerrada, `main` en `9acbb4a`, CI verde (4176 tests PASS / 0 failures). Primer release recomendado: **cliente piloto** (ver [Estado de release](#estado-de-release-post-auditoría)).

**Documentación:** v0.9.0 (2026-07) · **Última auditoría:** post-Gap12 release readiness (2026-10-05)

---

## Rápido inicio

```bash
bun install
cp .env.example .env              # Editar DATABASE_URL, SESSION_SECRET
bun run db:generate && bun run db:migrate
bun run dev                        # http://localhost:3000
```

Verificación:

```bash
npx vitest run                     # full suite (~4224 tests: 4176 PASS / 48 skip)
curl http://localhost:3000/api/health   # {"status":"healthy", ...}
```

> El script `test` no existe en `package.json`; la suite corre directo con Vitest. El conteo histórico "1014 tests" del README anterior estaba desactualizado.

---

## Qué es el proyecto

### Why AccountExpress?

Los ERPs contables tradicionales son pesados de configurar, opacos en sus decisiones y difíciles de auditar. AccountExpress está diseñado con el enfoque inverso: **reglas deterministas, IA explicable, auditoría completa y configuración externalizada**.

### Filosofía

| Principio | Significado |
|---|---|
| **Local First** | Sin dependencia de cloud para operación core |
| **Deterministic before AI** | Reglas explícitas primero, AI solo como fallback |
| **Evidence over assumptions** | Toda decisión se respalda con datos |
| **Zero hardcode** | Toda configuración externalizada (`rules/`) |
| **AI proposes, human decides** | La IA asiste; jamás posee decisiones contables |
| **Everything auditable** | Pista de auditoría encadenada con hashes |

### Flujo de dominio

```
Company → Fiscal Period → Bank Account → Bank Statement
    → Bank Transactions → Entity Detection → Bank Rules
    → Journal Entries → General Ledger → Reports
```

Entidades principales: `Company` con sus `FiscalPeriod`, `GlAccount`, `BankAccount`, `BankStatement`, `BankTransaction`, `BankRule`, `JournalEntry` y `JournalLine`.

### Arquitectura

```
Browser → React SPA → API Routes → Services
    → Decision Engine (reglas → AI) → Prisma → PostgreSQL
```

### Modelo de decisión IA

La IA **no contabiliza**. Solo propone cuando el motor determinista no tiene evidencia suficiente:

```
1. Regla explícita       → determinista
2. Contexto histórico    → determinista
3. Entity detection      → determinista
4. Sin evidencia         → AI propone (probabilístico)
5. Usuario decide        → decisión humana final
```

---

## Cómo se ejecuta el trabajo aquí (pasos de ejecución)

El proyecto se desarrolla bajo el **protocolo SISTEMA1**: la IA de análisis define, la IA de desarrollo ejecuta y certifica. Todo trabajo avanza mediante órdenes, no por iniciativa propia.

### Ciclo de una orden

```
IA de análisis emite EXECUTION LOCK
  → PASO 0: precondiciones (pin de rama, SHA, working tree)
  → PASO 1..N: ejecutar + verificar cada paso
  → SALIDA OBLIGATORIA: campos exactos de evidencia
  → ESPERANDO ORDEN DE IA DE ANÁLISIS
FIN SIGNIFICA FIN
```

### Flujo estándar de entrega (usado en los puntos 10–12)

```
rama desde origin/main → 1 archivo autorizado → suite directa 10/10 PASS
  → tsc --noEmit + git diff --check → commit controlado
  → push → PR → CI del PR verde
  → merge (--merge) → CI post-merge en main verde → cierre remoto
```

### Reglas de autoridad

| Regla | Significado |
|---|---|
| **Objetivo único** | Cada orden declara UN objetivo; nada fuera de su alcance |
| **Prohibición ≠ autorización** | El fin de una prohibición no habilita por sí solo (Engram requiere autorización positiva explícita) |
| **Sí no es sí** | Solo Omar / IA de análisis autoriza persistencia, commits, push, PR, merge |
| **Sin Gap por inercia** | Cerrada una cadena, el siguiente paso es decisión de roadmap, no código nuevo |
| **f10 sellado** | `tests/forensic/f10-audit-forgery.test.ts` nunca se lee/abre/greps/ejecuta |
| **Verificación antes de avanzar** | Cada PASO se verifica; si falla → `STOP — <MOTIVO>` |

### Patrón de verificación

1. **Pin** — declarar el estado esperado (SHA, rama, archivos).
2. **Act** — ejecutar exactamente lo autorizado.
3. **Verify** — constatar contra el pin; cualquier desvío detiene la ejecución.
4. **Report** — SALIDA con la evidencia en campos clave=valor.

---

## Cadena de ejecución (12 Gaps)

| Gap | Estado | Detalle |
|---|---|---|
| 1–8 | CLOSED | Cerrados en cadena previa (GAP8-2D: tenant-scoping de approvals) |
| 9 | CLOSED | Endpoint de explicación de decisiones (`/api/transactions/[id]/explanation`) |
| 10 | CLOSED_CERTIFIED | — |
| 11 | CLOSED_CERTIFIED | Módulos + entitlements (PR #100); pricing = `COMMERCIAL_DECISION_DEFERRED` |
| 12 | CLOSED_CERTIFIED | Certificación E2E final de comportamiento adaptativo (PR #101) |

### Evidencia de certificación (Gap 12)

| Métrica | Valor |
|---|---|
| Suite directa local | 10/10 PASS (J1–J12 + SAFETY) |
| Full suite remota | 4176 PASS / 48 skip / **0 failures** (364 files) |
| Reducción longitudinal | intervención inicial **3 → aprendida 0** (3 patrones) |
| Commit certificado | `7e6bb8bc` (1 archivo de test, 0 producción) |
| Merge | PR #101 → `9acbb4a0ab84e4630c9680e5bbbcaf515a1687ae` |
| CI | PR verde + post-merge en `main` verde |

**Propiedad demostrada:** *"el sistema piensa más y el usuario hace menos"* — cada ocurrencia aprendida se clasifica sola con evidencia persistida (trace + GL + knowledge), sin acción humana.

---

## Estado de release (post-auditoría)

| Dimensión | Estado |
|---|---|
| TECHNICAL_CORE | CERTIFIED |
| PRODUCT_FUNCTIONALITY | READY |
| COMMERCIAL_LAYER | PARTIALLY_READY |
| RELEASE_ENGINEERING | PARTIAL |
| CLIENT_DELIVERY_MATERIALS | PARTIAL |
| LICENSING | NOT DEFINED / NOT IMPLEMENTED |

**Target de primer release recomendado:** `PILOT_CUSTOMER` — delta mínimo (cero implementación de producto), conserva seguridad e integridad certificadas, sin licensing/packaging prematuros, y no bloquea la evolución a producto comercial completo.

### Checklist — Must have antes del primer cliente

- [ ] Procedimiento de instalación inicial + `prisma migrate deploy` (con backup previo)
- [ ] Alineación de versión (`APP_VERSION` coherente en health/diagnósticos)
- [ ] Procedimiento de backup/restore escrito para el usuario
- [ ] One-pager de términos del piloto
- [ ] Disclaimer Florida / verificación con contador

### Orden de trabajo (no ejecutado aún)

```
PHASE_1 (decisión comercial: términos piloto + moneda)
  → PHASE_2 (documentación: 3 docs del checklist)
  → PHASE_3 (release engineering: alineación de versión)
  → PHASE_4 (deploy del piloto — única fase que toca producción)
  → PHASE_5 (post-primer cliente: manual, soporte, upgrade)
```

Decisiones pendientes de pricing, currency, licensing y límites quedan **deferred** hasta la decisión de roadmap comercial.

---

## Documentación

| Tema | Dónde empezar |
|---|---|
| Arquitectura completa | `docs/architecture/overview.md` |
| Pipeline bancario | `docs/architecture/bank-import.md` |
| Modelo de IA | `docs/architecture/ai-decision-model.md` |
| Motor de reglas | `docs/architecture/rule-engine.md` |
| Nuevo desarrollador | `docs/getting-started/new-developer.md` |
| ADRs | `docs/adr/` |
| Principios de ingeniería | `docs/process/engineering-principles.md` |
| Glosario | `docs/glossary.md` |
| Invariantes del sistema | `docs/invariants.md` |
| Reglas de negocio | `docs/business-rules.md` |
| v0.9.0 release | `docs/releases/v0.9.0.md` |

### Orden de lectura sugerido

```
README → overview → engineering-principles
    → bank-import → ai-decision-model → rule-engine → ADRs
```

---

## Próximo paso

Decisión de roadmap: **release target final y plan de primer cliente** (`ANALYSIS_AI_FIRST_RELEASE_PLAN_DECISION`).
