# Sistema1 — Master TODO: ERP que aprende

Propósito:

Este documento registra el estado de los 12 bloques diagnosticados para
alcanzar la visión integral del ERP que aprende.

Reglas de autoridad:

- Omar es la única autoridad para objetivos y prioridades.
- Este TODO no autoriza ejecución.
- Cada implementación requiere una orden explícita.
- La IA de desarrollo no puede cambiar prioridades ni iniciar el siguiente
  bloque por cuenta propia.
- Los estados deben actualizarse únicamente con evidencia certificada.
- No marcar un bloque COMPLETADO porque exista infraestructura parcial.
- El detalle técnico certificado prevalece sobre una descripción conceptual.
- No rehacer Knowledge Engine: el núcleo ya existe.

Estados permitidos: `[ ] NOT_STARTED` · `[~] IN_PROGRESS` ·
`[x] COMPLETED` · `[!] BLOCKED`

---

## 1. [~] Cerrar el circuito de aprendizaje de punta a punta.

STATUS: IN_PROGRESS

CURRENT_EVIDENCE:
Existe infraestructura parcial ya observada: Step 1 cerró el loop E2E del
learning loop; 1A certificó la confirmación explícita de identidad con
tratamiento reutilizable en Knowledge Engine (merge 823cf023); 1B.1
certificó el transporte de `aiProposal` por el import resolver
(merge 9121e406); 1B.2A extrajo y certificó la autoridad servidor única
`reclassifyTransaction` para reclasificación contable + journal +
Knowledge Engine.

PROVEN_GAP:
El circuito AI proposal → decisión humana → contabilidad → aprendizaje
no está completo: el consumidor de `PendingApproval(action=
'ai_classification_proposal')` todavía no existe (pendiente 1B.2B+).
1B.2A sólo resolvió la autoridad servidor reutilizable; el circuito
completo sigue abierto.

DONE_WHEN:
Existe evidencia E2E de que una propuesta de IA pendiente recibe decisión
humana, aplica contabilidad vía la autoridad única y registra aprendizaje,
sin duplicar lógica ni pasar por HTTP interno.

### Evidencia / subpasos

[x] S10 Step 1 — auditoría E2E inicial del learning loop
    CLOSED

[x] S10 Step 1A — UNKNOWN correction → explicit identity confirmation
    → reusable Knowledge Engine treatment
    CLOSED_CERTIFIED_MERGED
    merge:
    823cf0231bac38ce1aa66cf77c06573e83b88e4e

[x] S10 Step 1B — auditoría AI fallback / PendingApproval
    CLOSED_AUDIT

[x] S10 Step 1B.1 — preservar aiProposal a través del import resolver
    CLOSED_CERTIFIED_MERGED
    merge:
    9121e406ae925c23a1c7fdd31024b063ad320231

[~] S10 Step 1B.2 — AI proposal
    → human decision
    → accounting
    → learning
    IN_PROGRESS

[x] S10 Step 1B.2A — extracción de autoridad servidor de reclasificación
    CLOSED_CERTIFIED_MERGED

technical commit:
49dd0ef96b274650b718ef020d017f7481e2ffd4

TODO commit:
990cfc5511504d357235acffda9167e3cee15444

PR:
#77

merge:
7472ed57d757f660516f7e3c0671150a5c8478e9

pre-merge CI:
36011339370
success

post-merge CI:
36012739638
success

build-and-secret-scan:
success

Autoridad extraída:

reclassifyTransaction({
  companyId,
  transactionId,
  glAccountId,
  confirmedEntity?
})

Estado certificado de 1B.2A:

- autoridad = reclassifyTransaction
- HTTP contract unchanged.
- Accounting semantics unchanged.
- Journal semantics unchanged.
- Knowledge Engine semantics unchanged.
- No duplicated domain sequence.
- 9 test files / 99 tests PASS.
- TypeScript PASS.
- git diff --check PASS.
- technical commit contiene exactamente 3 archivos.
- PR #77 CLOSED/MERGED.
- merge commit certificado.
- post-merge CI success.
- build-and-secret-scan success.
- AI proposal consumer todavía NO implementado.

NEXT_CERTIFIED_WORK_POINT:

S10 Step 1B.2A está CLOSED_CERTIFIED_MERGED.

PR:
#77

merge:
7472ed57d757f660516f7e3c0671150a5c8478e9

El circuito S10 Step 1B.2 continúa IN_PROGRESS.

El siguiente trabajo técnico debe partir del gap certificado:

PendingApproval(action='ai_classification_proposal')
→ decisión humana
→ reclassifyTransaction
→ aprendizaje

El TODO NO autoriza iniciar ese trabajo.
Requiere nueva orden explícita de la IA de análisis/control autorizada por Omar.

---

## 2. [~] Unificar definitivamente Knowledge Engine + Rule Engine + IA.

STATUS: IN_PROGRESS

CURRENT_EVIDENCE:
Existe jerarquía en funcionamiento observada: Knowledge Engine con
tratamientos/observaciones/conflictos, Rule Engine determinista y AI
fallback (`ai-bridge`, v2) que dispara ante no_match/ambiguous.
1B.1 preserva `aiProposal` hasta PendingApproval.

PROVEN_GAP:
No está certificada la unificación como circuito único: la propuesta de
IA todavía no consume ni aprende de forma integrada con decisión humana.

DONE_WHEN:
Existe evidencia E2E de una única secuencia KE → Rule Engine → IA →
decisión humana → aprendizaje sin rutas paralelas inconsistentes.

---

## 3. [~] Convertir el aprendizaje estadístico en comportamiento realmente acumulativo.

STATUS: IN_PROGRESS

CURRENT_EVIDENCE:
Existen learnEntityTreatment, recordClassificationObservation, evolución
de confianza, versionado (memoryVersion) y detección de conflictos con
degradación, probados en suites KE.

PROVEN_GAP:
No está certificado que el aprendizaje se acumule de forma consistente a
través de todos los canales de corrección (manual, batch, import) como
política única.

DONE_WHEN:
Evidencia E2E de que correcciones sucesivas en distintos canales
acumulan, versionan y consolidan conocimiento sin pisarse.

---

## 4. [~] Completar la inteligencia del importador bancario.

STATUS: IN_PROGRESS

CURRENT_EVIDENCE:
Existe import con resolución de reglas precedencia, transporte de
`aiProposal` (1B.1) y creación de PendingApproval de propuesta IA.

PROVEN_GAP:
No está certificada la inteligencia completa del importador: decisión
humana posterior y aprendizaje derivado del import aún no cierran el
circuito.

DONE_WHEN:
Evidencia E2E de import → propuesta → decisión → contabilidad →
aprendizaje reutilizable en el siguiente import.

---

## 5. [ ] Nuevo banco/formato → conocimiento reutilizable.

STATUS: NOT_STARTED

CURRENT_EVIDENCE:
No se diagnosticó infraestructura específica de este bloque en esta
fase.

PROVEN_GAP:
No existe evidencia de alta de banco/formato que genere conocimiento
reutilizable certificado.

DONE_WHEN:
Evidencia de que un formato nuevo aprendido se reaplica sin rediseño.

---

## 6. [~] Experiencia “arrastrar → aceptar”.

STATUS: IN_PROGRESS

CURRENT_EVIDENCE:
Existe ReclassifyDialog con confirmación de identidad (Step 1A) y
corrección de GL con PATCH certificado, probado en UI e integración.

PROVEN_GAP:
No está certificada la experiencia completa de arrastrar → aceptar de
extremo a extremo.

DONE_WHEN:
Evidencia E2E del flujo completo de aceptación con contabilidad y
aprendizaje verificados.

---

## 7. [~] De “aprender una corrección” a “aprender cómo trabaja esta empresa”.

STATUS: IN_PROGRESS

CURRENT_EVIDENCE:
Existen tratamientos por entidad, observaciones, autoridad de patrones y
confirmación humana con prioridad sobre inferencia.

PROVEN_GAP:
No está certificada la generalización a patrones de trabajo de la
empresa como política coherente.

DONE_WHEN:
Evidencia de que el sistema deriva comportamiento empresarial acumulado
más allá de correcciones aisladas.

---

## 8. [~] Memoria inmediata/estadística/permanente/explicable como política coherente.

STATUS: IN_PROGRESS

CURRENT_EVIDENCE:
Existen niveles de memoria operativos (immediata en resolución, persistente
en CompanyKnowledge/tratamientos, auditoría en KnowledgeAudit).

PROVEN_GAP:
No está certificada una política única que unifique los niveles con
explicabilidad.

DONE_WHEN:
Evidencia de una política de memoria coherente certificada across niveles.

---

## 9. [~] Explicabilidad visible para el usuario.

STATUS: IN_PROGRESS

CURRENT_EVIDENCE:
Existen logs de etapas KE, trazabilidad de conflictos y estados
entityStatus (KNOWN/UNKNOWN) expuestos por GET.

PROVEN_GAP:
No está certificada una experiencia visible de explicación para el
usuario final.

DONE_WHEN:
Evidencia de que el usuario ve y entiende por qué el sistema clasificó
de esa manera.

---

## 10. [~] Automatización progresiva: desconocido → sugerencia → confirmado → automático.

STATUS: IN_PROGRESS

CURRENT_EVIDENCE:
Existen los primeros eslabones: desconocido → sugerencia (aiProposal) y
corrección humana → conocimiento; contabilidad con journal auditable y
posibilidad de reclasificación.

PROVEN_GAP:
No está certificada la progresión completa con rollback, auditoría y
control humano sobre la transición a automático.

DONE_WHEN:
Evidencia E2E de la escala completa con auditoría y rollback
demostrados.

---

## 11. [ ] Modularización comercial del ERP.

STATUS: NOT_STARTED

CURRENT_EVIDENCE:
No se diagnosticó infraestructura de este bloque en esta fase.

PROVEN_GAP:
No existe evidencia de modularización comercial implementada.

DONE_WHEN:
Evidencia de módulos comerciales desacoplados y certificados.

---

## 12. [ ] Certificar el objetivo: “el sistema piensa más y el usuario hace menos”.

STATUS: NOT_STARTED

CURRENT_EVIDENCE:
No existe certificación integral del objetivo final.

PROVEN_GAP:
Los bloques previos no están completados; falta la certificación global.

DONE_WHEN:
Existe evidencia certificada de que la intervención humana disminuyó sin
perder control, integridad contable ni explicabilidad.

---

## Principios establecidos

- Knowledge Engine NO debe rehacerse.
- Company isolation es obligatoria.
- Conocimiento confirmado tiene prioridad sobre inferencia.
- Jerarquía objetivo:
  Knowledge Engine
  → Rule Engine
  → IA fallback
  → decisión humana cuando corresponda
  → aprendizaje.
- La IA no puede autoaplicar una clasificación no confirmada salvo que una
  política futura explícitamente certificada lo autorice.
- Toda automatización progresiva debe conservar auditoría y rollback.
- Una corrección humana nunca debe enseñar el valor incorrecto propuesto por IA.
- Aprendizaje y automatización no son equivalentes.
- El objetivo final es reducir intervención humana sin perder control,
  integridad contable ni explicabilidad.

---

## Historial de actualización

2026-09-24
- Creado Master TODO de los 12 bloques.
- Paso 1 en progreso.
- Step 1A cerrado y mergeado.
- Step 1B.1 cerrado y mergeado.
- Step 1B.2 en progreso.
- Step 1B.2A implementado/certificado localmente, todavía sin commit.

2026-09-24
- Step 1B.2A commiteado localmente en
  49dd0ef96b274650b718ef020d017f7481e2ffd4
  (refactor(learning): extract transaction reclassification authority),
  todavía sin push.

2026-09-24
- S10 Step 1B.2A CLOSED_CERTIFIED_MERGED.
- PR #77.
- merge 7472ed57d757f660516f7e3c0671150a5c8478e9.
- post-merge CI 36012739638 success.
- build-and-secret-scan success.
- Step 1B.2 continúa IN_PROGRESS.
- AI proposal consumer todavía NO implementado.
