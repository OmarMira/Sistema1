# Glossary

| Término | Definición |
|---|---|
| **BankAccount** | Cuenta bancaria real de una empresa, vinculada a una `GlAccount` del plan de cuentas |
| **BankRule** | Regla de clasificación automática definida por empresa: condiciones de match + acción (categoría, entidad, cuenta contable) |
| **BankStatement** | Extracto bancario importado (PDF/OFX/CSV). Contiene saldos y transacciones de un período |
| **BankTransaction** | Transacción individual dentro de un extracto. Corazón del sistema: toda clasificación, regla y asiento parte de acá |
| **CompanyKnowledge** | Registro polimórfico de información sobre una empresa: empleados, proveedores, clientes, cuentas, etc. |
| **DecisionEngine** | Pipeline que evalúa una transacción: primero reglas deterministas, luego IA si no hay match |
| **EntityContext** | Entidad detectada en una transacción (proveedor, cliente, empleado). Se usa para clasificación automática |
| **FiscalPeriod** | Período contable (mensual, trimestral, anual). Bloqueable para impedir cambios en histórico |
| **GlAccount** | Cuenta del plan de cuentas contable. Jerárquica (parent/child). Ej: "1010 - Caja" |
| **JournalEntry** | Asiento contable. Siempre balancea (débitos = créditos). Vinculado a transacciones conciliadas |
| **JournalLine** | Línea individual de un asiento: cuenta contable + débito o crédito |
| **ReconciliationPeriod** | Período de conciliación bancaria. Asocia transacciones con asientos contables |
| **Session** | Sesión de usuario (cookie-based, bcryptjs, sin JWT) |
| **SystemMemory** | Memoria persistente del sistema. Almacena contexto para decisiones futuras, con embeddings |
| **SystemConfig** | Configuración global del sistema. No pertenece a ninguna empresa en particular |
