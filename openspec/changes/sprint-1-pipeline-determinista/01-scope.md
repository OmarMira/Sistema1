# Sprint 1 — Pipeline Determinista Vacío

## Alcance del Sprint

### Objetivo
Construir el pipeline determinístico del Rule Engine v2 que toma un input, filtra reglas activas, evalúa condiciones, descarta inválidas y produce un `Candidate[]`. Sin ranking, sin resolución de ambigüedad, sin IA.

### Qué entra
- Pipeline orchestrator (`pipeline.ts`) según el contrato definido en ADR-009
- Módulo de errores (`errors.ts`)
- Barrel export público gated por feature flag (`index.ts`)
- Tests unitarios del pipeline

### Qué NO entra (Sprint 2+)
- Ranking de candidatos → Sprint 2
- Resolución de ambigüedad (DELTA threshold) → Sprint 2
- `EngineDecision` final (winner / ambiguous / no_match) → Sprint 2
- AuditLog → Sprint 3
- Explainability → Sprint 3
- Integración con Import Service → Sprint 4
- AI Bridge → Sprint 4
- Rule Lifecycle management → Sprint 5
- UI → Frontend sprint
- Reglas con AND/OR tree, fuzzy matching, plugins → v2.1+

### Deliverable
- `src/lib/rule-engine/pipeline.ts`
- `src/lib/rule-engine/errors.ts`
- `src/lib/rule-engine/index.ts`
- `tests/rule-engine/pipeline.test.ts`

### Definition of Done
1. Pipeline acepta `RuleInput`, procesa los 4 pasos y retorna `Candidate[]`
2. Sin reglas activas → `Candidate[]` vacío
3. Una regla válida produce un `Candidate`
4. Regla con condición que NO matchea → descartada
5. Misma entrada + mismas reglas → mismo resultado (determinismo garantizado)
6. Pipeline no muta el input original
7. Feature flag `RULE_ENGINE_V2_ENABLED=true` → pipeline ejecuta. `false` → no ejecuta
8. Todos los tests pasan
9. `tsc --noEmit` sin errores
10. `npm run build` exitoso
