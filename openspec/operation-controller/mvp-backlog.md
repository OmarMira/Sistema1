# Operation Controller — MVP Backlog

## Alcance del MVP

- Recurso único: archivos de texto planos
- Sin base de datos, sin Git, sin red, sin shell
- Evidence en memoria (no durable)
- Sin concurrencia (ejecución secuencial)
- Sin integración con IA (el requester es externo al Controller)

## Backlog

### Kernel

- [ ] **Execution Contract** — representación autorizada de una operación. Delimita target, operaciones permitidas, efectos permitidos/prohibidos, budget y estado esperado.
- [ ] **Policy** — evalúa el Intent contra las reglas vigentes y determina si puede autorizarse. Si procede, habilita la creación del Execution Contract; de lo contrario produce Denied o PendingApproval.
- [ ] **Execute** — recibe Contract Authorized + Driver; ejecuta la operación y devuelve resultado
- [ ] **Verify** — relee el workspace post-ejecución; compara estado real vs expectedState + detecta mutaciones laterales
- [ ] **Evidence** — registro append-only de cada transición (Requested, Denied, Authorized, Executing, Executed, Verified, Completed, Failed)
- [ ] **OperationController** — orquesta el pipeline completo; recibe Intent, produce estado terminal

### Resource Drivers

- [ ] **FileResource** — driver para archivos de texto. Lee, escribe, elimina archivos dentro de un workspace delimitado

### Contención

- [ ] **safePath** — canonicaliza rutas con realpathSync; rechaza path traversal, rutas absolutas fuera del workspace, symlinks externos
- [ ] **Workspace** — delimita el directorio base donde el Controller puede operar

### Estados y errores

- [ ] Estados terminales: Completed, Denied, Failed (con subtipos: VerifyFailed, EvidenceFailed, BudgetExceeded, etc.)
- [ ] Manejo de errores: cada estado terminal incluye metadata (razón, paso donde falló, snapshot)

### Tests

- [ ] Test: modificación autorizada (ruta correcta, efecto permitido, operation permitida)
- [ ] Test: path fuera del workspace es rechazado
- [ ] Test: creación con forbiddenEffects: [create] es rechazada
- [ ] Test: delete con forbiddenEffects: [delete] es rechazado
- [ ] Test: Verify detecta driver que miente (estado real ≠ expectedState)
- [ ] Test: Evidence falla antes de Authorized → Execute no se invoca
- [ ] Test: budget declarado excede maxChanges → rechazado
- [ ] Test: snapshot lateral detecta modificación en archivo no target

### No entra en MVP

- GitResource, DbResource, NetworkResource, ShellResource
- Evidence durable (journal, WAL)
- Concurrencia / locks
- Cálculo automático de budget por diff real (reemplazar predictEffects heurístico)
- Integración con IA (autopilot, requester automático)
- Notificación / escalamiento post-fallo
- Aislamiento a nivel OS (contenedores, chroot)