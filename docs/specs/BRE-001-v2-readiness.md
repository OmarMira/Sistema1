# BRE-001: V2 Readiness — Estabilización del Bank Rules Engine

- **ID:** BRE-001
- **Status:** En ejecución
- **Base:** ADR-009
- **Dependencias:** MW-001 (completado)
- **TDR relacionados:** TDR-001 (Amount Semantics — diferido)

---

## Objetivo

Dejar el Bank Rules Engine V2 listo para convertirse en el único motor oficial sin riesgo.
No se activa V2 como default. No se migran reglas existentes. No se elimina legacy.

---

## Alcance

### 1. Tests del adapter bridge (BRE-001-A)

**Estado:** ✅ Completado

Cobertura creada en `tests/unit/rule-engine-adapter.test.ts` (12 tests).
Tests existentes confirmados en `tests/services/rule-engine-adapter/` (3 archivos, 846 líneas).

### 2. Signed amounts

**Estado:** 🔄 Diferido a TDR-001

El hallazgo está validado (Legacy/Precedence usan `Math.abs()`, V2 no).
Pero corresponde a un cambio de contrato del dominio, no a una tarea de estabilización del V2.

Se reemplaza por `docs/architecture/TDR-001-amount-semantics.md` que documenta:
- Semántica oficial de `amount`
- Diferencias entre Legacy, Precedence y V2
- Impacto de cada alternativa
- Estrategia de migración

La implementación del contrato se abordará en un work item separado (BRE-006+).

### 3. Shadow mode con alerta (no silencioso)

Actualmente las divergencias entre engines se loggan pero no alertan.

**Cambio:** Crear `RuleEngineDivergenceEvent` type y emitirlo cuando V2 y precedence producen distinto ganador.

**Archivos:**
- `src/lib/rule-engine/events.ts` (nuevo) — tipo del evento de divergencia
- `src/lib/services/import.service.ts` — emitir evento cuando hay divergencia

### 4. Feature flag cleanup

Mantener los 3 flags pero preparar `BANK_RULE_ENGINE=v2` como ruta principal.

**Cambio:** Renombrar/consolidar flags para que sea explícito cuál es el motor default y cuáles son legacy.

**Archivos:**
- `src/lib/rule-engine/flag.ts` — limpiar nomenclatura, agregar `getEngineMode(): 'legacy' | 'precedence' | 'v2'`
- `src/lib/services/rule-precedence-import-resolver.ts` — actualizar lógica de ruteo

### 5. Persistencia de AuditRecord

V2 produce `AuditRecord` con candidateList completa pero nunca persiste a DB.

**Cambio:** Crear tabla `RuleExecutionAudit` vía Prisma migration y hook de persistencia.

**Archivos:**
- `prisma/schema.prisma` — nuevo modelo `RuleExecutionAudit`
- Migración Prisma
- `src/lib/rule-engine/audit.ts` — hook de persistencia a DB

---

## Archivos afectados (lista completa autorizada)

### Modificar

- `src/lib/services/import.service.ts`
- `src/lib/rule-engine/flag.ts`
- `src/lib/rule-engine/audit.ts`
- `src/lib/services/rule-precedence-import-resolver.ts`
- `prisma/schema.prisma`

### Crear

- `docs/specs/BRE-001-v2-readiness.md` (este documento)
- `tests/unit/rule-engine-adapter.test.ts` (completado)
- `src/lib/rule-engine/events.ts`
- Migración Prisma (`prisma/migrations/`)

### NO modificar

- `src/lib/rule-engine/pipeline.ts`
- `src/lib/rule-engine/specificity.ts`
- `src/lib/rule-engine/ranking.ts`
- `src/lib/rule-engine/types.ts`
- `src/lib/rule-engine/errors.ts`
- `src/lib/rule-engine/index.ts`
- `src/lib/rule-engine/conditions/*.ts`
- `src/lib/rule-engine-adapter/*.ts`
- `src/lib/services/rule-matching-engine.ts`
- `src/lib/services/rule-precedence-engine.ts`
- `src/lib/services/rule-precedence-compat.ts`
- `src/lib/services/rule-precedence-adapters.ts`
- `src/lib/services/rule-precedence-shadow.ts`
- `src/lib/services/reconciliation.service.ts`
- `src/lib/services/reconciliation.ts`
- Auth, backup, encryption, `.env*`, `package.json`, `next.config.ts`
- Kernel Operation Controller files

---

## Cambios no permitidos

- ❌ Activar V2 como default
- ❌ Eliminar legacy engine
- ❌ Migrar reglas existentes
- ❌ Cambiar algoritmo de ranking (specificity, tiers, match quality)
- ❌ Modificar ADR-009
- ❌ Modificar el pipeline de evaluación del V2
- ❌ Cambiar contrato de amount (diferido a TDR-001)
- ❌ Tocar archivos fuera de la lista autorizada

---

## Tests requeridos

### Baseline (pre-cambio)

```
Branch: main
HEAD: <actual>
git status --short: clean
npx tsc --noEmit: OK
npx vitest run --no-file-parallelism: 100%
```

### Tests a crear

| Suite | Archivo | Estado |
|---|---|---|
| Adapter edge cases | `tests/unit/rule-engine-adapter.test.ts` | ✅ 12 tests |
| Shadow divergence events | A definir en bloque 3 | Pendiente |
| Flag routing | A definir en bloque 4 | Pendiente |
| Audit persistence | A definir en bloque 5 | Pendiente |

### Regression gate (post-cambio)

```
npx tsc --noEmit
npm run lint
npx vitest run --no-file-parallelism
```

Comparar contra baseline: 0 regresiones.

---

## Rollback

### Si el cambio está en working tree (sin commit)

```bash
git restore .
git clean -fd
```

### Si el cambio está commitado pero no pusheado

```bash
git reset --soft HEAD~1
git restore .
git clean -fd
```

### Si el cambio está pusheado

```bash
git revert HEAD --no-edit
git push origin main
```

### Migración de base de datos

Si se agregó `RuleExecutionAudit`:

```bash
npx prisma migrate reset  # solo en dev
# O revertir la migration específica:
npx prisma migrate down <migration-name>
```

---

## Definition of Done

- [x] Cobertura de tests del adapter (12 tests, edge cases)
- [ ] Divergence event creado y emitido en shadow mode
- [ ] Feature flags consolidados con `BANK_RULE_ENGINE=v2` como ruta principal
- [ ] `RuleExecutionAudit` creado en schema + migración + hook de persistencia
- [ ] `docs/architecture/TDR-001-amount-semantics.md` creado y aprobado
- [ ] `npx tsc --noEmit` exitoso
- [ ] `npm run lint` sin nuevos errores
- [ ] `npx vitest run --no-file-parallelism` al 100%
- [ ] `git status` limpio
- [ ] Rollback plan documentado y viable
