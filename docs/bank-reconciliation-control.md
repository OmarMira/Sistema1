# Preparar información bancaria para la contadora

La pantalla de conciliación organiza información de trabajo para revisión contable. No firma ni presenta declaraciones oficiales. Los resúmenes pueden importarse en cualquier momento, incluso en un año posterior al de sus movimientos.

## Cómo leer la pantalla

1. Selecciona la cuenta bancaria y los extractos que deseas controlar.
2. Revisa el período de los documentos, su saldo inicial y la moneda. La fecha de carga no cambia ese período.
3. Consulta los pendientes del listado y las fechas de corte antes de interpretar la diferencia.
4. Usa **Exportar informe de trabajo** para descargar el TXT existente; la contadora determina el tratamiento y prepara su reporte anual.

| Información | Alcance |
|---|---|
| Período y saldo inicial | Extractos seleccionados; con todos seleccionados, desde el inicio del más antiguo hasta el cierre más reciente. No depende del año actual. |
| Movimientos importados | Total de la cuenta bancaria, no solamente del listado filtrado. |
| Sin clasificación guardada | Movimientos del listado cargado que aún no tienen cuenta de contrapartida guardada. Una selección local todavía no confirmada no cambia este contador. |
| Sin asiento vinculado | Movimientos del listado sin enlace a un asiento ni a una línea de diario. No se infiere si la respuesta no trae esos datos. |
| Saldo según banco | Cierre del extracto seleccionado, o del último extracto si están todos seleccionados. Sin extractos, se usa el saldo de la cuenta. |
| Saldo según libros | Asientos contabilizados hasta el corte indicado. El campo **Hasta (movimientos)** también cambia este corte; se muestra su hora UTC exacta. Sin filtro final ni extractos, no hay límite de fecha. |
| Diferencia | Banco menos libros, sin alterar su importe. Si las fechas de corte son distintas, aparece una advertencia. No demuestra por sí sola un error de importación. |
| Estados de conciliación | Contadores de toda la cuenta; una conciliación o revisión interna no equivale a aprobación de la contadora. |

## Acciones que cambian la contabilidad

**Crear Asientos Contables** conserva su valor inicial activado. La ayuda indica si la confirmación solicitará asientos publicados; el diálogo de confirmación existente permanece. Cambiar el interruptor por sí solo no crea asientos, y desactivarlo no elimina los existentes.

La cuenta elegida en cada fila es la **contrapartida del movimiento**, no el vínculo contable de la cuenta bancaria. **Crear Ajuste** es una operación contable independiente: no hace falta para importar o descargar información, ni debe usarse solamente para ocultar una diferencia.

## Descarga y límites

La descarga mantiene el formato TXT y el comportamiento existentes: saldos mostrados y movimientos del listado filtrado. No se agregó un nuevo formato de reporte, firma, presentación fiscal ni estado de aprobación profesional. Los filtros pueden hacer que la descarga no incluya todos los movimientos del año.

Por ejemplo, documentos de 2025 cargados en 2026 siguen perteneciendo a 2025. Un asiento con fecha posterior al corte no entra en el saldo contable de ese corte. Esta explicación no modifica fechas, saldos iniciales, reglas ni movimientos almacenados.

## Verificación aislada

`node node_modules/vitest/vitest.mjs run --config vitest.reconciliation-clarity.config.ts`

Estas pruebas de interfaz simulan HTTP y no cargan archivos `.env`, preparación de base de datos ni datos reales. No usar el `vitest.config.ts` general para esta comprobación: tiene preparación de base de datos. La prueba DOM no reemplaza una inspección visual en un navegador real.
