'use client';

import { useMemo, type ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { bankCategories, cents, savedCategory, statementContext, type BankActivityData, type BankMovement } from '@/lib/dashboard/bank-activity';
import { buildMonthlyBalances } from '@/lib/financial-dashboard-monthly';
const colors = ['#0d9488', '#3b82f6', '#f97316', '#a855f7', '#eab308', '#64748b'];
const translations = {
  es: {
    title: 'Gráficos de la actividad bancaria',
    scope: 'Entradas, salidas y clasificaciones respetan los filtros. Los saldos y promedios proceden del período completo de los extractos; no se recalculan con un subconjunto.',
    incoming: 'Entradas',
    outgoing: 'Salidas',
    balance: 'Saldo del extracto',
    average: 'Promedio diario',
    unassigned: 'Sin asignar',
    noData: 'Sin movimientos de este tipo en la selección.',
    unavailable: 'No hay información suficiente para comprobar estos saldos o promedios.',
    flow: 'Entradas y salidas por mes',
    balanceTitle: 'Saldo de los extractos por mes',
    expenses: 'Salidas por clasificación',
    income: 'Entradas por clasificación',
    net: 'Diferencia entre entradas y salidas',
    topExpense: 'Principal clasificación de salidas',
    expenseTrends: 'Principales clasificaciones de salidas',
    incomeTrends: 'Principales clasificaciones de entradas',
    averageTitle: 'Saldo promedio diario por mes',
    review: 'Conciliados y pendientes por mes',
    filtered: 'Importes de los movimientos incluidos; no representan ganancias ni gastos deducibles.',
    source: 'Importes originales del último extracto de cada mes. Un tramo sin extracto no se reemplaza por cero.',
    categories: 'Clasificaciones guardadas, incluido “Sin asignar”; no se deducen por la descripción bancaria.',
    top: 'Evolución mensual de las clasificaciones con mayor importe en esta consulta.',
    netHelp: 'Entradas menos salidas. La línea de cero separa entrada neta y salida neta, no ganancia y pérdida.',
    averageHelp: 'Promedio de los saldos diarios, calculado con todos los movimientos y un saldo inicial comprobado. Solo disponible para meses completos.',
    reviewHelp: 'Cantidad de movimientos incluidos por estado. Pendiente no significa que el banco no registró el movimiento.',
    reconciled: 'Conciliados',
    pending: 'Pendientes',
    indicators: 'Indicadores de la consulta',
    total: 'Movimientos incluidos',
    credits: 'Cantidad de entradas',
    debits: 'Cantidad de salidas',
    progress: 'Conciliados en esta consulta',
    largestIn: 'Mayor entrada',
    largestOut: 'Mayor salida'
  },
  en: {
    title: 'Bank activity charts',
    scope: 'Money in, money out and classifications respect the filters. Balances and averages use the complete statement period, never a filtered subset.',
    incoming: 'Money in',
    outgoing: 'Money out',
    balance: 'Statement balance',
    average: 'Daily average',
    unassigned: 'Unassigned',
    noData: 'No movements of this type in this selection.',
    unavailable: 'Insufficient information to verify these balances or averages.',
    flow: 'Monthly money in and out',
    balanceTitle: 'Monthly statement balances',
    expenses: 'Money out by classification',
    income: 'Money in by classification',
    net: 'Money in minus money out',
    topExpense: 'Largest outgoing classification',
    expenseTrends: 'Largest outgoing classifications',
    incomeTrends: 'Largest incoming classifications',
    averageTitle: 'Monthly average daily balance',
    review: 'Monthly reconciled and pending movements',
    filtered: 'Amounts from included movements; these are not business profit or deductible expenses.',
    source: 'Original closing of the last statement in each month. Missing statements are not replaced by zero.',
    categories: 'Saved classifications, including Unassigned; never inferred from bank descriptions.',
    top: 'Monthly evolution of the classifications with the largest amounts in this query.',
    netHelp: 'Money in minus money out. Zero separates net inflows and outflows, not profit and loss.',
    averageHelp: 'Average daily balances using all movements and a verified opening balance. Available only for complete months.',
    reviewHelp: 'Included movement counts by status. Pending does not mean the bank failed to record the movement.',
    reconciled: 'Reconciled',
    pending: 'Pending',
    indicators: 'Query indicators',
    total: 'Included movements',
    credits: 'Incoming movement count',
    debits: 'Outgoing movement count',
    progress: 'Reconciled in this query',
    largestIn: 'Largest money in',
    largestOut: 'Largest money out'
  }
};
type Month = ReturnType<typeof import('@/lib/dashboard/bank-activity').bankMonths>[number];
interface Props {
  data: BankActivityData;
  visible: BankMovement[];
  months: Month[];
  language: 'es' | 'en';
  money: (value: number | null) => string;
}
function ChartBox({
  title,
  description,
  children
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return <Card className="min-w-0 gap-0 p-4 sm:p-6"><figure aria-label={title} className="min-w-0">
    <figcaption className="mb-4"><h3 className="font-semibold">{title}</h3><p className="mt-2 text-sm text-muted-foreground">{description}</p></figcaption>
    {children}
  </figure></Card>;
}
export function BankActivityIndicators({
  visible,
  language,
  money
}: Pick<Props, 'visible' | 'language' | 'money'>) {
  const copy = translations[language];
  const incoming = visible.filter(t => t.tipo === 'credito');
  const outgoing = visible.filter(t => t.tipo === 'debito');
  const largest = (rows: BankMovement[]) => rows.length ? rows.reduce((max, row) => Math.max(max, row.monto), -Infinity) : null;
  const metrics = [[copy.total, String(visible.length)], [copy.credits, String(incoming.length)], [copy.debits, String(outgoing.length)], [copy.progress, visible.length ? `${(visible.filter(t => t.conciliado).length / visible.length * 100).toFixed(1)}%` : '—'], [copy.largestIn, money(largest(incoming))], [copy.largestOut, money(largest(outgoing))]];
  return <section aria-label={copy.indicators} className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {metrics.map(([label, value]) => <Card key={label} className="min-w-0 relative overflow-hidden"><CardContent className="p-6"><h3 className="text-sm font-medium text-muted-foreground">{label}</h3><p className="mt-2 break-words text-2xl font-bold tracking-tight tabular-nums">{value}</p></CardContent></Card>)}
  </section>;
}
export function BankActivityCharts({
  data,
  visible,
  months,
  language,
  money
}: Props) {
  const copy = translations[language];
  const expenses = bankCategories(visible, 'debito');
  const income = bankCategories(visible, 'credito');
  const category = (name: string) => name === 'Sin asignar' ? copy.unassigned : name;
  const topExpenses = expenses.slice(0, 3);
  const topIncome = income.slice(0, 3);
  const averages = useMemo(() => {
    const context = statementContext(data);
    const end = new Date(context.end + 'T00:00:00Z');
    const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
    return new Map(context.verified && context.start.endsWith('-01') && end.getUTCDate() === lastDay ? buildMonthlyBalances(data.transactions, context.opening!).map(month => [month.monthKey, month.promedio]) : []);
  }, [data]);
  const series = months.map(month => {
    const rows = visible.filter(t => t.fecha.startsWith(month.key));
    const sum = (name: string, type: string) => rows.filter(t => t.tipo === type && savedCategory(t) === name).reduce((total, t) => total + cents(t.monto), 0) / 100;
    return {
      ...month,
      label: new Date(month.key + '-01T00:00:00Z').toLocaleDateString(language === 'en' ? 'en-US' : 'es-ES', {
        month: 'short',
        timeZone: 'UTC'
      }),
      average: averages.get(month.key) ?? null,
      ...Object.fromEntries(topExpenses.map((c, i) => [`expense${i}`, sum(c.name, 'debito')])),
      ...Object.fromEntries(topIncome.map((c, i) => [`income${i}`, sum(c.name, 'credito')])),
      reconciled: rows.filter(t => t.conciliado).length,
      pending: rows.filter(t => !t.conciliado).length
    };
  });
  const axis = [<CartesianGrid key="grid" strokeDasharray="3 3" vertical={false} opacity={0.25} />, <XAxis key="months" dataKey="label" fontSize={11} tickLine={false} axisLine={false} />, <YAxis key="amounts" width={76} fontSize={10} tickLine={false} axisLine={false} tickFormatter={value => new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1
  }).format(Number(value))} />, <Tooltip key="values" formatter={value => money(Number(value))} />, <Legend key="legend" wrapperStyle={{
    fontSize: 12
  }} />];
  const plot = (chart: React.ReactElement) => <ResponsiveContainer width="100%" height={250} minWidth={0} initialDimension={{
    width: 600,
    height: 250
  }}>{chart}</ResponsiveContainer>;
  const pie = (rows: typeof expenses) => !rows.length ? <p className="py-12 text-sm text-muted-foreground">{copy.noData}</p> : <>
    {plot(<PieChart><Pie data={rows} dataKey="value" nameKey="name" innerRadius="48%" outerRadius="85%" isAnimationActive={false}>{rows.map((row, i) => <Cell key={row.name} fill={row.name === 'Sin asignar' ? '#64748b' : colors[i % colors.length]} />)}</Pie><Tooltip formatter={value => money(Number(value))} /></PieChart>)}
    <ul className="mt-3 space-y-2 text-sm">{rows.map((row, i) => <li key={row.name} className="flex flex-wrap justify-between gap-x-3 gap-y-1"><span className="min-w-0 break-words"><span aria-hidden="true" className="mr-2 inline-block size-2 rounded-full" style={{
            backgroundColor: row.name === 'Sin asignar' ? '#64748b' : colors[i % colors.length]
          }} />{category(row.name)}</span><span className="tabular-nums">{money(row.value)} · {row.percentage.toFixed(1)}%</span></li>)}</ul>
  </>;
  return <section aria-label={copy.title} className="space-y-4">
    <header><h2 className="text-xl font-semibold">{copy.title}</h2><p className="mt-2 max-w-4xl text-sm text-muted-foreground">{copy.scope}</p></header>
    <div className="grid min-w-0 gap-6 xl:grid-cols-2">
      <ChartBox title={copy.flow} description={copy.filtered}>{plot(<BarChart data={series}>{axis}<Bar dataKey="incoming" name={copy.incoming} fill={colors[0]} radius={[4, 4, 0, 0]} isAnimationActive={false} /><Bar dataKey="outgoing" name={copy.outgoing} fill={colors[2]} radius={[4, 4, 0, 0]} isAnimationActive={false} /></BarChart>)}</ChartBox>
      <ChartBox title={copy.balanceTitle} description={copy.source}>{series.some(m => m.closing !== null) ? plot(<AreaChart data={series}>{axis}<Area dataKey="closing" name={copy.balance} stroke={colors[1]} fill={colors[1]} fillOpacity={0.12} connectNulls={false} isAnimationActive={false} /></AreaChart>) : <p className="py-12 text-sm">{copy.unavailable}</p>}</ChartBox>
      <ChartBox title={copy.expenses} description={copy.categories}>{pie(expenses)}</ChartBox>
      <ChartBox title={copy.income} description={copy.categories}>{pie(income)}</ChartBox>
      <ChartBox title={copy.net} description={copy.netHelp}>{plot(<BarChart data={series}>{axis}<ReferenceLine y={0} stroke="#94a3b8" /><Bar dataKey="net" name={copy.net} isAnimationActive={false}>{series.map(row => <Cell key={row.key} fill={row.net >= 0 ? colors[0] : colors[2]} />)}</Bar></BarChart>)}</ChartBox>
      <ChartBox title={copy.topExpense} description={copy.top}>{topExpenses.length ? plot(<BarChart data={series}>{axis}<Bar dataKey="expense0" name={category(topExpenses[0].name)} fill={colors[3]} isAnimationActive={false} /></BarChart>) : <p className="py-12 text-sm">{copy.noData}</p>}</ChartBox>
      <ChartBox title={copy.expenseTrends} description={copy.top}>{topExpenses.length ? plot(<LineChart data={series}>{axis}{topExpenses.map((row, i) => <Line key={row.name} dataKey={`expense${i}`} name={category(row.name)} stroke={colors[i]} strokeWidth={2} isAnimationActive={false} />)}</LineChart>) : <p className="py-12 text-sm">{copy.noData}</p>}</ChartBox>
      <ChartBox title={copy.incomeTrends} description={copy.top}>{topIncome.length ? plot(<LineChart data={series}>{axis}{topIncome.map((row, i) => <Line key={row.name} dataKey={`income${i}`} name={category(row.name)} stroke={colors[i]} strokeWidth={2} isAnimationActive={false} />)}</LineChart>) : <p className="py-12 text-sm">{copy.noData}</p>}</ChartBox>
      <ChartBox title={copy.averageTitle} description={copy.averageHelp}>{series.some(m => m.average !== null) ? plot(<LineChart data={series}>{axis}<Line dataKey="average" name={copy.average} stroke={colors[3]} strokeWidth={2} connectNulls={false} isAnimationActive={false} /></LineChart>) : <p className="py-12 text-sm">{copy.unavailable}</p>}</ChartBox>
      <ChartBox title={copy.review} description={copy.reviewHelp}>{plot(<BarChart data={series}><CartesianGrid strokeDasharray="3 3" vertical={false} opacity={0.25} /><XAxis dataKey="label" fontSize={11} /><YAxis width={40} allowDecimals={false} fontSize={11} /><Tooltip /><Legend wrapperStyle={{
            fontSize: 12
          }} /><Bar dataKey="reconciled" name={copy.reconciled} stackId="status" fill={colors[0]} isAnimationActive={false} /><Bar dataKey="pending" name={copy.pending} stackId="status" fill={colors[2]} isAnimationActive={false} /></BarChart>)}</ChartBox>
    </div>
  </section>;
}
