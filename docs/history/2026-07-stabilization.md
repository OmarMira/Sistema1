# Stabilization: July 2026

## Before

El proyecto funcionaba pero acumulaba deuda técnica crítica:

- Tests escribiendo en base de producción (contaminación histórica: 1728 registros)
- 157 tests fallando, muchos asumidos como "pre-existentes"
- `SESSION_SECRET` con fallback hardcodeado en desarrollo
- Validación de backups rota (comment vs code mismatch)
- Un test legacy skipped que daba falsa impresión de cobertura pendiente
- Sin documentación de arquitectura, decisiones, ni procesos

## What was done

| Área | Problema | Acción | Resultado |
|---|---|---|---|
| **DB Isolation** | Tests escribían en producción | Doble guardia (`vitest.config.ts` + `db.ts` safety-net) | Tests aislados permanentemente |
| **Test Health** | 157 failures en 30+ archivos | Investigación con evidencia, no asunciones | 1014 passed, 0 failed |
| **validateBackup** | Regresión silenciosa | Fix de producción | Backup validation correcta |
| **SESSION_SECRET** | Fallback hardcodeado | Obligatorio en todos los entornos | Sin modo inseguro |
| **DB Cleanup** | 1728 registros de prueba en prod | Backup → dry-run → DELETE quirúrgico | Solo datos reales preservados |
| **Legacy test** | Test skip engañoso | Eliminado tras verificar que no representaba caso real | 0 skipped |
| **Documentation** | Inexistente | README + architecture + ADRs + process + glossary + invariants | Sistema de documentación completo |

## Key decisions made

- **Evidence over assumptions**: toda decisión técnica requiere datos verificables
- **DB isolation**: config-time + runtime, no una sola guardia
- **SESSION_SECRET**: sin fallback en ningún entorno
- **Legacy tests**: eliminar si no representan caso real, no mantener "por las dudas"
- **Local first**: sin dependencia cloud para core
- **AI as assistant**: IA propone, nunca decide sobre contabilidad
- **Zero hardcode**: toda configuración externalizada

## What remains for the future

- **Deterministic Rule Engine v2**: el próximo sprint
- **UI para reglas**: crear/ordenar reglas desde interfaz
- **Fuzzy matching**: patrones tipo regex en BankRules
- **Testing del rule engine**: suite dedicada
- **SECURITY_AUDIT.md finding 5.1**: pending production verification
- **Multi-instance support**: rate limiting distribuido, backups cloud
