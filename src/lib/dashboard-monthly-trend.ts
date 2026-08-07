/**
 * Clave "YYYY-MM" del mes civil al que pertenece una transacción de banco.
 *
 * Las fechas civiles se almacenan como medianoche UTC, por lo que leer el Date
 * con getters locales desplaza el día/mes en timezones de offset negativo.
 * Leer con componentes UTC es determinista e independiente del timezone del
 * proceso que construye el monthlyTrend del dashboard.
 */
export function monthlyTrendKey(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
