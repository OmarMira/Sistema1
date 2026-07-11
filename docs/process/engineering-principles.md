# Engineering Principles

Estos principios se consolidaron durante la etapa de estabilización (v0.9.0). Reflejan decisiones reales, no aspiraciones teóricas.

---

## 1. Evidence over assumptions

Toda decisión técnica se respalda con datos verificables (archivo + línea). No se aceptan afirmaciones sin evidencia.

**Aplica a:** bugs, vulnerabilidades, causas raíz, decisiones de arquitectura.

---

## 2. Tests describen comportamiento, no implementación

Un test no debe acoplarse a la implementación interna. Debe describir qué hace el sistema desde la perspectiva del usuario/contrato.

**Señal de alerta:** mockear funciones privadas o depender de estructura interna.

---

## 3. No modificar producción solo para hacer pasar tests

Si un test falla, la causa es el test o el setup — no la lógica de negocio. Modificar producción para satisfacer un test esconde bugs.

**Excepción:** cuando el test revela un bug real en producción (validado con evidence).

---

## 4. Toda vulnerabilidad cita evidencia

Cada finding de seguridad debe incluir el archivo y línea donde ocurre. Sin evidencia, no es un finding.

---

## 5. Un test skip requiere justificación o se elimina

`it.skip` sin comentario explícito no se acepta. Si no representa un caso real, se elimina en lugar de mantenerse "por las dudas".

---

## 6. Deterministic before AI

Las reglas explícitas del negocio tienen prioridad sobre clasificación probabilística. La AI solo participa cuando no hay evidencia determinista suficiente.

---

## 7. AI proposes, never decides

La IA puede sugerir clasificaciones. La decisión final sobre un asiento contable es siempre humana o determinista.

---

## 8. Everything auditable

Toda operación con efecto contable se registra en `AuditLog` con hash chain. No hay operaciones invisibles.

---

## Versioning

| Versión | Fecha | Cambios |
|---|---|---|
| 1.0 | 2026-07 | Principios iniciales post-estabilización |
