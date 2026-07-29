# Design: Accounting Readiness Center

## Decision Principles

1. **El Centro nunca decide por el usuario.** Muestra el estado, explica por qué, recomienda una acción, pero la decisión final siempre es del contador.
2. **Siempre explica por qué.** Toda recomendación incluye el razonamiento (regla activada, datos evaluados, impacto esperado). Sin `porque lo digo yo`.
3. **Nunca confía en datos cacheados para operaciones críticas.** El botón "Cerrar período" re-ejecuta `ReadinessService.assess()` antes de cerrar. Ignora el estado que el frontend tenía al cargar.
4. **Una recomendación siempre debe poder ejecutarse.** Si el Centro dice "Clasificar 18 entidades", ese link debe llevar exactamente a la pantalla donde se clasifican esas 18 entidades, no a una pantalla genérica.
5. **Ningún módulo conoce la UI.** El backend devuelve acciones con tipos y entidades, no rutas de navegación. El frontend decide cómo presentarlas (ruta, modal, etc.).
6. **Las reglas son declarativas y extensibles.** Agregar una regla nueva es agregar un archivo con `condition` + `evaluate` + `priority`, no modificar 20 `if` en un servicio.
7. **La integridad es propiedad del dominio, no un módulo separado.** Cada servicio existente expone su propio juicio de integridad. ReadinessService compone esos juicios, no los descubre.

---

## 1. Domain Model — V5.1 (canonical)

### RuleDefinition

```typescript
type RuleId = 'B1' | 'B2' | 'B3' | 'B4' | 'B5' | 'B6' | 'W1' | 'W2' | 'W3' | 'W4' | 'W5';

type RuleModule = 'journal' | 'backup' | 'fiscal_periods' | 'reconciliation' | 'entities';

interface RuleDefinition {
  id: RuleId;
  type: 'blocker' | 'warning';
  domain: 'integrity' | 'operational';
  dependsOn: RuleId[];
  /** Evaluación síncrona y pura sobre la foto */
  predicate: (snapshot: EvaluationSnapshot) => boolean;
  /** Genera el hallazgo estructurado */
  actionBuilder: (snapshot: EvaluationSnapshot) => AssessmentFinding;
}
```

### EvaluationSnapshot

```typescript
interface EvaluationSnapshot {
  companyId: string;
  periodId: string;
  period: {
    id: string;
    startDate: Date;
    endDate: Date;
    closed: boolean;
  } | null;
  previousPeriod: {
    id: string;
    closed: boolean;
  } | null;
  journals: {
    balanced: boolean;
    debits: number;
    credits: number;
    incompleteCount: number;
  };
  reconciliation: {
    unreconciledCount: number;
    ignoredCount: number;
    orphanCount: number;
    mismatchedCount: number;
  };
  entities: {
    pendingCount: number;
    lowConfidenceCount: number;
  };
  backup: {
    latestDate: Date | null;
    latestFilename: string | null;
  };
  systemConfig: {
    modulesEnabled: string[];
  };
  snapshotTakenAt: string;
}
```

### AssessmentFinding

```typescript
interface AssessmentFinding {
  ruleId: RuleId;
  type: 'blocker' | 'warning';
  severity: 1 | 2 | 3;
  area: 'fiscal_periods' | 'classification' | 'reconciliation' | 'journal_integrity' | 'backup' | 'import';
  sourceModule: RuleModule;
  reasonCode: string;
  action: ActionRef | null;
}
```

### ActionRef

```typescript
interface ActionRef {
  command: 'OPEN_RECONCILIATION' | 'OPEN_ENTITY_CLASSIFICATION' | 'OPEN_FISCAL_PERIODS' | 'RUN_BACKUP';
  requiredCapability: 'RECONCILIATION' | 'FISCAL_CLOSE' | 'BACKUP' | 'ENTITY_CLASSIFICATION';
  params: Record<string, string | undefined>;
}
```

### Recommendation

```typescript
interface Recommendation {
  priority: 1 | 2 | 3;
  action: ActionRef;
  reasonCode: string;
  blockingRuleIds: RuleId[];
  estimatedImpact: {
    blockersResolved: number;
    healthScoreDelta: number;
  };
}
```

### HealthScore

```typescript
interface HealthScore {
  score: number;
  deductions: { ruleId: RuleId; points: number; reasonCode: string }[];
  bonuses: { ruleId: RuleId; points: number; reasonCode: string }[];
  calculationVersion: string;
}
```

### ReadinessAssessment

```typescript
interface ReadinessAssessment {
  periodId: string;
  globalState: 'READY' | 'WARNING' | 'BLOCKED';
  confidence: { score: number; reasons: string[] };
  blockers: AssessmentFinding[];
  warnings: AssessmentFinding[];
  primaryRecommendation: Recommendation | null;
  nextActions: Recommendation[];
  healthScore: HealthScore;
}
```

Compuerta lógica de `globalState`:
- **BLOCKED**: existe al menos un blocker
- **WARNING**: sin blockers, existe al menos un warning
- **READY**: sin blockers ni warnings

### ReadinessResponse

```typescript
interface ReadinessResponse {
  assessment: ReadinessAssessment;
  version: {
    contractVersion: '1.0.0';
    engineVersion: string;
    ruleSetVersion: string;
    generatedBy: 'ReadinessEngine';
  };
  trace?: {
    rulesEvaluated: number;
    blockersFound: number;
    warningsFound: number;
    durationMs: number;
    log?: string[];
  };
}
```

### HealthScoreRule (declarativa)

```typescript
interface HealthScoreRule {
  id: string;
  category: HealthCategory;
  weight: number;                // puntos a deducir (siempre > 0, el motor los aplica como negativos)
  description: string;
  condition: (snapshot: EvaluationSnapshot) => boolean | number;  // boolean = deducción completa, number = deducción proporcional
  explanation: (snapshot: EvaluationSnapshot) => string;
}
```

Ejemplos:

```typescript
const RULES: HealthScoreRule[] = [
  {
    id: 'backup_age',
    category: 'backups',
    weight: 10,                     // 10 puntos por día excedente
    description: 'Backup antiguo',
    condition: (snapshot) => Math.max(0, daysSince(snapshot.latestBackup) - 7),
    explanation: (snapshot) => `Backup: último hace ${daysSince(snapshot.latestBackup)} días (máx permitido: 7)`,
  },
  {
    id: 'pending_classifications',
    category: 'clasificacion',
    weight: 5,
    description: 'Entidades pendientes',
    condition: (snapshot) => snapshot.pending.count,
    explanation: (snapshot) => `${snapshot.pending.count} entidades sin clasificar`,
  },
];
```

El motor itera reglas en orden, evalúa `condition`, si > 0 aplica `weight * condition` como deducción.

### Confidence

`ReadinessAssessment.confidence` representa qué tan confiable es la evaluación. Se calcula como un objeto con score y razones:

| Factor | Impacto en score | Razón incluida |
|---|---|---|
| Importaciones parciales | -0.15 | "importaciones parciales" |
| Datos faltantes / error de servicio | -0.20 | "errores en servicios consultados" |
| Módulos deshabilitados | -0.10 por módulo | "módulo X deshabilitado" |
| Última importación > 24h y período abierto | -0.10 | "importación antigua" |

Confianza alta (0.95+) + estado READY → el usuario puede cerrar con seguridad.
Confianza baja (< 0.80) + estado READY → el sistema sugiere re-validar antes de cerrar.

**No mide:** calidad de datos histórica, precisión de IA, exactitud de clasificaciones, ni ningún otro factor ajeno a la completitud de la evaluación.

---

## 2. Pipeline de evaluación

```
ReadinessService.assess()
  ↓
RulesEngine.evaluate(snapshot)
  → AssessmentFinding[]            // hallazgos crudos sin orden
  ↓
PrioritizationEngine.rank(findings)
  → RankedFinding[]                // ordenados por impacto
  ↓
RecommendationBuilder.build(rankedFindings)
  → primaryRecommendation + nextActions
```

Este pipeline desacopla:
- **Rules**: genera hallazgos (bloqueantes y warnings)
- **Prioritization**: ordena por impacto, no por orden de evaluación
- **Recommendation**: construye el mensaje legible para el usuario

El mismo pipeline puede reutilizarse para alertas, notificaciones y reportes sin volver a evaluar reglas.

---

## 3. Integridad como propiedad del dominio

No hay `IntegrityService`. Cada servicio existente expone la integridad de su dominio:

| Servicio existente | Método | Devuelve |
|---|---|---|
| `JournalService` | `.checkBalanced(companyId, periodId)` | `{ status, description }` |
| `JournalService` | `.checkCompleteEntries(companyId, periodId)` | `{ status, description }` |
| `ReconciliationService` | `.checkOrphanTransactions(companyId)` | `{ status, description, count }` |
| `ReconciliationService` | `.checkForeignKeyReferences(companyId)` | `{ status, description }` |
| `FiscalPeriodService` | `.checkPeriodGaps(companyId)` | `{ status, description }` |
| `FiscalPeriodService` | `.checkDuplicateClosures(companyId)` | `{ status, description }` |

ReadinessService:

```typescript
class ReadinessService {
  async assess(companyId: string, periodId: string): Promise<ReadinessResponse> {
    // Paso 1: recolectar contexto de cada servicio existente
    const [periods, pending, reconciliation, journal, backup] = await Promise.all([
      FiscalPeriodService.getActive(companyId),
      EntityService.countPending(companyId, periodId),
      ReconciliationService.getStatus(companyId, periodId),
      JournalService.getBalance(companyId, periodId),
      BackupService.getLatest(companyId),
    ]);

    // Paso 2: integridad — cada dominio se evalúa a sí mismo
    const integrityChecks = await Promise.all([
      JournalService.checkBalanced(companyId, periodId),
      JournalService.checkCompleteEntries(companyId, periodId),
      ReconciliationService.checkOrphanTransactions(companyId),
      ReconciliationService.checkForeignKeyReferences(companyId),
      FiscalPeriodService.checkPeriodGaps(companyId),
      FiscalPeriodService.checkDuplicateClosures(companyId),
    ]);

    // Paso 3: construir snapshot congelado
    const snapshot: EvaluationSnapshot = buildSnapshot(companyId, periodId, { periods, pending, reconciliation, journal, backup, integrityChecks });

    // Paso 4: ejecutar reglas sobre el snapshot
    const findings = RulesEngine.evaluate(snapshot);
    const blockers = findings.filter(f => f.type === 'blocker');
    const warnings = findings.filter(f => f.type === 'warning');

    // Paso 5: calcular health score
    const healthScore = HealthScoreCalculator.calculate(snapshot);

    // Paso 6: priorizar findings → ranking
    const rankedFindings = PrioritizationEngine.rank(findings);

    // Paso 7: construir recomendaciones desde el ranking
    const { primary, nextActions } = RecommendationBuilder.build(rankedFindings);

    // Paso 8: calcular confianza de la evaluación
    const confidence = ConfidenceCalculator.calculate(snapshot);

    // Paso 9: armar respuesta
    const globalState = blockers.length > 0 ? 'BLOCKED' : warnings.length > 0 ? 'WARNING' : 'READY';

    return {
      assessment: {
        periodId,
        globalState,
        confidence,
        blockers,
        warnings,
        primaryRecommendation: primary,
        nextActions,
        healthScore,
      },
      version: {
        contractVersion: '1.0.0',
        engineVersion: '1.0.0',
        ruleSetVersion: '1.0.0',
        generatedBy: 'ReadinessEngine',
      },
    };
  }
}
```

---

## 4. Endpoint

```
GET /api/accounting/readiness?companyId=xxx&periodId=xxx
GET /api/accounting/readiness?companyId=xxx&periodId=xxx&trace=true
```

### Respuesta (abreviada)

```json
{
  "assessment": {
    "periodId": "period-001",
    "globalState": "BLOCKED",
    "confidence": {
      "score": 0.95,
      "reasons": []
    },
    "blockers": [
      {
        "ruleId": "B1",
        "type": "blocker",
        "severity": 1,
        "area": "fiscal_periods",
        "sourceModule": "fiscal_periods",
        "reasonCode": "PREVIOUS_PERIOD_OPEN",
        "action": {
          "command": "OPEN_FISCAL_PERIODS",
          "requiredCapability": "FISCAL_CLOSE",
          "params": { "periodId": "period-004" }
        }
      }
    ],
    "warnings": [],
    "primaryRecommendation": {
      "priority": 1,
      "action": {
        "command": "OPEN_FISCAL_PERIODS",
        "requiredCapability": "FISCAL_CLOSE",
        "params": { "periodId": "period-004" }
      },
      "reasonCode": "CLOSE_PREVIOUS_PERIOD_FIRST",
      "blockingRuleIds": ["B1"],
      "estimatedImpact": {
        "blockersResolved": 1,
        "healthScoreDelta": 0
      }
    },
    "nextActions": [],
    "healthScore": {
      "score": 72,
      "deductions": [
        { "ruleId": "backup_age", "points": -10, "reasonCode": "BACKUP_AGE_EXCEEDED" },
        { "ruleId": "pending_classifications", "points": -15, "reasonCode": "PENDING_ENTITIES" }
      ],
      "bonuses": [],
      "calculationVersion": "1.0.0"
    }
  },
  "version": {
    "contractVersion": "1.0.0",
    "engineVersion": "1.0.0",
    "ruleSetVersion": "1.0.0",
    "generatedBy": "ReadinessEngine"
  }
}
```

Con `?trace=true` se agrega `trace` al response.

---

## 5. UI (Centro Contable)

La UI es consecuencia directa del modelo de dominio. El frontend:

1. Recibe `ReadinessResponse.assessment`
2. Mapea `ActionRef.command → URL` con un mapper centralizado
3. Renderiza componentes según el estado

### ActionMapper

```typescript
const ACTION_ROUTES: Record<string, (ref: ActionRef) => string> = {
  OPEN_RECONCILIATION: (r) => `/reconciliation?accountId=${r.params.accountId}&periodId=${r.params.periodId}`,
  OPEN_ENTITY_CLASSIFICATION: (r) => `/learning/pending-entities?periodId=${r.params.periodId}`,
  OPEN_FISCAL_PERIODS: (r) => `/fiscal-periods/${r.params.periodId}/close`,
  RUN_BACKUP: () => `/backup`,
};
```

El backend **no conoce estas rutas**. Solo devuelve `ActionRef`.

---

## 6. Plan de implementación

### Fase 1 — Motor de reglas + endpoint + UI básica

| Item | Cómo |
|---|---|
| HealthScoreRule[] declarativas | `src/lib/accounting-readiness/rules/health-score-rules.ts` |
| Reglas de bloqueo (B1–B6) | `src/lib/accounting-readiness/rules/blocker-rules.ts` |
| Reglas de warning (W1–W5) | `src/lib/accounting-readiness/rules/warning-rules.ts` |
| EvaluationSnapshot builder | `src/lib/accounting-readiness/snapshot-builder.ts` |
| ReadinessService | `src/lib/accounting-readiness/readiness.service.ts` |
| ConfidenceCalculator | `src/lib/accounting-readiness/confidence-calculator.ts` |
| RulesEngine (evaluate → AssessmentFinding[]) | `src/lib/accounting-readiness/rules-engine.ts` |
| PrioritizationEngine (rank → RankedFinding[]) | `src/lib/accounting-readiness/prioritization-engine.ts` |
| RecommendationBuilder (build → primary + nextActions) | `src/lib/accounting-readiness/recommendation-builder.ts` |
| Métodos assess() en servicios existentes | `JournalService.checkBalanced()`, etc. |
| Endpoint | `src/app/api/accounting/readiness/route.ts` |
| ActionMapper en frontend | `src/lib/accounting-readiness/action-mapper.ts` |
| Página Centro Contable | `src/app/accounting-center/page.tsx` |
| Tests | `tests/lib/accounting-readiness/*.test.ts` + `tests/api/accounting-readiness.test.ts` |

### Fase 2 — Cierre desde el Centro

| Item | Cómo |
|---|---|
| Botón "Cerrar período" con re-validación server-side | Nuevo endpoint o re-uso de `POST /api/fiscal-periods/close` |
| Validación pre-cierre: `ReadinessService.assess()` → si READY → `ClosePeriodService.close()` | En el backend |

### Fase 3 (póstergable) — Alertas proactivas

Sin `CenterAssessmentLog`. Se evalúa cuando haya uso real del Centro.

---

## 7. Naming

| Concepto | Nombre |
|---|---|
| Módulo de dominio | `Readiness` (Accounting Period) |
| Servicio principal | `ReadinessService` |
| Evaluación | `ReadinessAssessment` |
| Endpoint | `GET /api/accounting/readiness` |
| UI | Centro Contable (`/accounting-center`) |
| Carpeta backend | `src/lib/accounting-readiness/` |
| Carpeta frontend | `src/app/accounting-center/` |

---

## 8. Historical Contracts

### V3 Contract (REPLACED)

**Status**: Deprecated
**Replaced by**: V5.1 (sección 1 de este documento)
**Replacement date**: 2026-07-29

**Reason for replacement**:
- `ActionRef` usaba `type: ActionType` (snake_case, dominio puro) sin modelo de capabilities. V5.1 introduce `command` + `requiredCapability` para permitir control de autorización server-side.
- `confidence` era `number` escalar sin explicación. V5.1 usa `{ score: number, reasons: string[] }` para que el usuario entienda por qué la confianza no es 1.0.
- `HealthScore` usaba `{ total, deductions, confidence, trend }` con cálculo de 100 - deducciones. V5.1 introduce `{ score, deductions, bonuses, calculationVersion }` permitiendo bonificaciones y versionamiento.
- `Blocker`, `Warning` y `Finding` eran interfaces separadas con campos duplicados. V5.1 las unifica en `AssessmentFinding` con `sourceModule`.
- `EvaluationContext` era un objeto contextual mutable. V5.1 lo reemplaza por `EvaluationSnapshot` (foto congelada, snapshot inmutable) para permitir funciones de evaluación puras, testables y serializables.

**Do not implement new features using V3.** Las definiciones V3 se mantienen en este documento únicamente como registro histórico de la decisión arquitectónica, no como especificación activa.

Para referencia, V3 definía:
- `ReadinessAssessment` con `period: PeriodInfo`, `confidence: number`, `Blocker[]`, `Warning[]`
- `ActionRef` con `type: ActionType` (snake_case) y `entityId?`, `companyId?`, `periodId?`
- `Blocker` y `Warning` como interfaces separadas
- `Finding` como tipo intermedio del pipeline
- `HealthScore` con `total`, `deductions`, `confidence`, `trend`
- `DecisionTrace` como metadato de evaluación (reemplazado por `ReadinessResponse.trace`)
- Pipeline `RulesEngine → PrioritizationEngine → RecommendationBuilder` (preservado en sección 2)
- `ConfidenceCalculator` como clase independiente (preservado conceptualmente en sección 1)

---

## Appendix: Design changelog

| Fecha | Versión | Cambio |
|---|---|---|
| 2026-07-29 | V5.1 → canónico | V3 contracts movidos a Historical Contracts como REPLACED. V5.1 queda como único contrato activo. |
| 2026-07-29 | V5.1 | Contrato inicial con RuleDefinition, EvaluationSnapshot, AssessmentFinding, ActionRef (command+capabilities), ReadinessResponse. |
| (anterior) | V3 | Contrato original con Blocker/Warning/Finding separados, ActionRef (type-based), confidence escalar. |