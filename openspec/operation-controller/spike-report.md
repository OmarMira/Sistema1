# Operation Controller — Spike Report

## Alcance del Spike

- Entorno aislado: carpeta temporal fuera del repositorio principal
- Recursos: archivos de texto planos (a.txt, b.txt, c.txt)
- Kernel: Intent → Policy → Execution Contract → Execute → Verify + Evidence transversal
- Contención: lógica, mediante canonicalización de rutas (realpathSync + path.relative)
- Duración: una ejecución, 7 casos, sin iteración

## Casos ejecutados

| # | Caso | Contrato | Operación | Status esperado | Status real | Resultado |
|---|------|----------|-----------|-----------------|-------------|-----------|
| 1 | Modificación autorizada | target: a.txt, allowedOps: [write], allowedEffects: [modify], forbiddenEffects: [create,delete], budget: maxChanges=1 | write a.txt "modificado por controlador" | COMPLETED | COMPLETED | TEST PASS |
| 2 | Path distinto al target | target: a.txt, mismas restricciones | write b.txt "modificado" | REJECTED | REJECTED (path mismatch) | TEST PASS |
| 3 | Creación prohibida | target: nuevo.txt, allowedEffects: [modify], forbiddenEffects: [create] | write nuevo.txt "contenido nuevo" | REJECTED | REJECTED (forbidden effect: create) | TEST PASS |
| 4 | Delete prohibido | target: b.txt, allowedOps: [write], forbiddenEffects: [delete] | delete b.txt | REJECTED | REJECTED (operation not allowed) | TEST PASS |
| 5 | Driver miente, Verify detecta | target: a.txt, allowedEffects: [modify], expectedState: {a.txt: "modificado..."} | write a.txt (LyingResource escribe contenido distinto) | VERIFY_FAILED | VERIFY_FAILED (state mismatch) | TEST PASS |
| 6 | Evidence falla antes de mutar | target: a.txt | write a.txt, evidence.failAt("Authorized") | ABORT | ABORT (evidence write failed at Authorized) | TEST PASS |
| 7 | Budget excedido | target: a.txt, budget: maxChanges=1 | write a.txt con changes:2 | REJECTED | REJECTED (budget exceeded: 2 > 1) | TEST PASS |

## Propiedades demostradas

1. **Ejecución autorizada**: El pipeline completa exitosamente una operación cuando el Contract la permite.
2. **Rechazo por ruta**: Toda operación cuyo path no coincide con el target del Contract es rechazada antes de Authorized, sin mutaciones.
3. **Rechazo por efecto prohibido**: Toda operación cuyo efecto no está en allowedEffects o está en forbiddenEffects es rechazada antes de Authorized.
4. **Rechazo por operación no permitida**: Toda operación cuyo nombre no está en allowedOperations es rechazada.
5. **Verify independiente**: Verify relee el workspace directamente y detecta cuando el estado real no coincide con el expectedState del Contract, incluso si el Driver reporta éxito.
6. **Snapshot lateral**: Verify compara el estado pre-ejecución y post-ejecución para detectar creaciones, eliminaciones o modificaciones no autorizadas en cualquier archivo del workspace.
7. **Evidence aborta antes de mutar**: Si Evidence.write("Authorized") falla, Execute nunca es invocado y ningún archivo cambia.
8. **Budget preventivo**: El Controller rechaza solicitudes cuyo `changes` declarado excede `maxChanges`. El cálculo automático del diff real queda fuera del alcance del Spike.
9. **Contención canónica**: El Spike implementa una estrategia de canonicalización basada en `realpathSync` y `path.relative` para contener operaciones dentro del workspace.

## Propiedades NO demostradas

1. **Aislamiento físico del sistema operativo**: La contención es lógica (dentro del proceso Node.js). No se probó aislamiento a nivel OS (contenedores, chroot, permisos).
2. **Symlinks reales**: El workspace del spike no contenía symlinks. La resolución canónica está implementada pero no probada contra un symlink real apuntando fuera del workspace.
3. **Race conditions / concurrencia**: Todos los casos se ejecutaron secuencialmente. No se probó ejecución concurrente sobre el mismo recurso.
4. **Persistencia durable de Evidence**: Evidence fue in-memory. No se probó escritura síncrona a disco, journal, WAL ni recuperación ante fallos.
5. **Escalamiento humano post-fallo**: Los estados FAILED_UNRECORDED_RESULT y VERIFY_FAILED se registran pero no se probó la notificación ni el flujo de escalamiento.
6. **Contención cross-resource**: Solo se probó FileResource. No se probaron interacciones entre File + Git + DB + Network.
7. **Cálculo de budget por diff real**: El budget se validó contra un valor declarado (changes: 2 > maxChanges: 1). No se calculó a partir del diff real de contenido.
8. **PredictEffects heurístico**: La predicción de efectos (create vs modify) se basa en la existencia previa del archivo, no en el diff real post-ejecución.

## Limitaciones conocidas

1. **Entorno de prueba**: Carpeta temporal aislada, no el repositorio real de Account Express.
2. **Recurso único**: Solo archivos de texto planos. Sin Git, sin base de datos, sin red, sin shell.
3. **Sin integración con IA**: El requester fue simulado. La IA de desarrollo todavía tiene acceso directo a shell y repositorio.
4. **Evidence no durable**: Toda la evidencia se pierde al cerrar el proceso.
5. **Budget declarativo**: El valor de `changes` lo declara el requester; no se calcula automáticamente.
6. **Sin pruebas de seguridad ofensivas**: No se intentaron bypass, inyección de Contract, ni manipulación de Evidence.

## Conclusión

El Spike demuestra que el paradigma del Operation Controller (Execution Contract como frontera de ejecución) es conceptualmente viable. Las 7 pruebas pasaron. Sin embargo, esto no constituye una validación de seguridad de producción. Las propiedades demostradas son lógicas y están limitadas al entorno controlado del spike. **El Spike valida la arquitectura del pipeline, no la seguridad completa del sistema.**