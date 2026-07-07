'use client';

import React from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ReferenceLine, ResponsiveContainer,
} from 'recharts';
import { PALETTE } from '@/lib/constants/financial-dashboard-types';
import { LOCAL_TRANSLATIONS } from '@/lib/constants/financial-dashboard-translations';
import { formatCurrency } from '@/lib/format';

// ── ChartBox helper component ────────────────────────────────────

interface ChartBoxProps {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

function ChartBox({ title, subtitle, children }: ChartBoxProps) {
  return (
    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-3xl p-6 shadow-sm flex flex-col justify-between">
      <header className="mb-4">
        <h3 className="text-sm font-bold text-slate-900 dark:text-white uppercase tracking-wider">
          {title}
        </h3>
        <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-1">
          {subtitle}
        </p>
      </header>
      <div className="relative z-10 w-full mt-2">{children}</div>
    </div>
  );
}

// ── Reusable tooltip style ───────────────────────────────────────

const tooltipStyle = {
  backgroundColor: '#0f172a',
  border: 'none',
  borderRadius: '1rem',
  color: '#fff',
};

// ── Props ────────────────────────────────────────────────────────

interface ChartsGridProps {
  language: string;
  monthlyAggregatedData: Array<{
    monthKey: string;
    monthLabel: string;
    ingresos: number;
    gastos: number;
    netFlow: number;
    cierre: number;
    promedio: number;
  }>;
  minCierreMonth: string | null;
  expensesByCategoryData: Array<{ name: string; value: number; color: string; percentage: number }>;
  incomeByCategoryData: Array<{ name: string; value: number; color: string; percentage: number }>;
  topExpenseCategory: string;
  topExpenseCategoryData: Array<{ month: string; Monto: number }>;
  recurrentExpensesData: Array<Record<string, unknown>>;
  top3ExpenseCategories: string[];
  platformIncomeData: Array<Record<string, unknown>>;
  top3IncomeCategories: string[];
  topIncomeCategory: string;
  rentasVsOperacionesData: Array<{ month: string; Rentas: number; Operaciones: number }>;
}

// ── Export ───────────────────────────────────────────────────────

export function ChartsGrid(props: ChartsGridProps) {
  const {
    language, monthlyAggregatedData, minCierreMonth,
    expensesByCategoryData, incomeByCategoryData,
    topExpenseCategory, topExpenseCategoryData,
    recurrentExpensesData, top3ExpenseCategories,
    platformIncomeData, top3IncomeCategories,
    topIncomeCategory, rentasVsOperacionesData,
  } = props;

  const dt = LOCAL_TRANSLATIONS[language] || LOCAL_TRANSLATIONS.es;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-8">
      {/* Chart 1: Ingresos vs Egresos por Mes */}
      <ChartBox title={dt.incomeVsExpensesMonth} subtitle={dt.monthlyFlowComparison}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart
            data={monthlyAggregatedData}
            margin={{ top: 10, right: 10, left: -20, bottom: 0 }}
          >
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(128,128,128,0.12)" />
            <XAxis dataKey="monthLabel" stroke="#888780" fontSize={10} axisLine={false} tickLine={false} />
            <YAxis stroke="#888780" fontSize={10} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
            <Tooltip formatter={(value: string | number) => formatCurrency(Number(value))} contentStyle={tooltipStyle} />
            <Legend verticalAlign="top" height={36} iconType="circle" />
            <Bar dataKey="ingresos" fill={PALETTE.verde} name={dt.incomeLabel} radius={[4, 4, 0, 0]} barSize={16} />
            <Bar dataKey="gastos" fill={PALETTE.rojo} name={dt.expensesLabel} radius={[4, 4, 0, 0]} barSize={16} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>

      {/* Chart 2: Evolución del saldo al cierre */}
      <ChartBox title={dt.balanceEvolution} subtitle={dt.balanceDynamics}>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={monthlyAggregatedData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <defs>
              <linearGradient id="areaBal" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={PALETTE.azul} stopOpacity={0.2} />
                <stop offset="95%" stopColor={PALETTE.azul} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(128,128,128,0.12)" />
            <XAxis dataKey="monthLabel" stroke="#888780" fontSize={10} axisLine={false} tickLine={false} />
            <YAxis stroke="#888780" fontSize={10} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
            <Tooltip formatter={(value: string | number) => formatCurrency(Number(value))} contentStyle={tooltipStyle} />
            <Area
              type="monotone" dataKey="cierre" stroke={PALETTE.azul} strokeWidth={2.5}
              fill="url(#areaBal)" name={dt.cierreLabel}
              dot={(dotProps: { cx?: number; cy?: number; payload: { monthKey: string } }) => {
                const { cx, cy, payload } = dotProps;
                if (payload.monthKey === minCierreMonth) {
                  return <circle cx={cx} cy={cy} r={6} fill={PALETTE.rojo} stroke="#fff" strokeWidth={2} />;
                }
                return <path d="" />;
              }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </ChartBox>

      {/* Chart 3: Distribución de egresos */}
      <ChartBox title={dt.expensesDistribution} subtitle={dt.relativeCompositionExpenses}>
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <ResponsiveContainer width="100%" height={200} className="max-w-[200px]">
            <PieChart>
              <Pie
                data={expensesByCategoryData.filter((d) => d.value > 0)}
                cx="50%" cy="50%" innerRadius={60} outerRadius={80}
                paddingAngle={3} dataKey="value"
              >
                {expensesByCategoryData.filter((d) => d.value > 0).map((entry, idx) => (
                  <Cell key={`cell-${idx}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip formatter={(value: string | number) => formatCurrency(Number(value))} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1 grid grid-cols-2 gap-x-4 gap-y-2">
            {expensesByCategoryData.map((c) => (
              <div key={c.name} className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300 truncate max-w-[140px]">
                  {c.name === 'Sin asignar' ? (language === 'en' ? 'Unassigned' : 'Sin asignar') : c.name}
                </span>
                <span className="text-[10px] font-bold text-slate-400 ml-auto">{c.percentage.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      </ChartBox>

      {/* Chart 4: Distribución de ingresos */}
      <ChartBox title={dt.incomeDistribution} subtitle={dt.relativeCompositionIncome}>
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <ResponsiveContainer width="100%" height={200} className="max-w-[200px]">
            <PieChart>
              <Pie
                data={incomeByCategoryData.filter((d) => d.value > 0)}
                cx="50%" cy="50%" innerRadius={60} outerRadius={80}
                paddingAngle={3} dataKey="value"
              >
                {incomeByCategoryData.filter((d) => d.value > 0).map((entry, idx) => (
                  <Cell key={`cell-${idx}`} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip formatter={(value: string | number) => formatCurrency(Number(value))} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1 grid grid-cols-2 gap-x-4 gap-y-2">
            {incomeByCategoryData.map((c) => (
              <div key={c.name} className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: c.color }} />
                <span className="text-xs font-medium text-slate-600 dark:text-slate-300 truncate max-w-[140px]">
                  {c.name === 'Sin asignar' ? (language === 'en' ? 'Unassigned' : 'Sin asignar') : c.name}
                </span>
                <span className="text-[10px] font-bold text-slate-400 ml-auto">{c.percentage.toFixed(1)}%</span>
              </div>
            ))}
          </div>
        </div>
      </ChartBox>

      {/* Chart 5: Flujo Neto Mensual */}
      <ChartBox title={dt.netMonthlyFlow} subtitle={dt.cashRetentionCapacity}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={monthlyAggregatedData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(128,128,128,0.12)" />
            <XAxis dataKey="monthLabel" stroke="#888780" fontSize={10} axisLine={false} tickLine={false} />
            <YAxis stroke="#888780" fontSize={10} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
            <Tooltip formatter={(value: string | number) => formatCurrency(Number(value))} contentStyle={tooltipStyle} />
            <Bar dataKey="netFlow" radius={[4, 4, 0, 0]} barSize={20}>
              {monthlyAggregatedData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.netFlow >= 0 ? PALETTE.verdeClaro : PALETTE.rojoClaro} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>

      {/* Chart 6: Principal categoría de egreso */}
      <ChartBox
        title={`${language === 'en' ? 'Evolution of: ' : 'Evolución de: '}${topExpenseCategory === 'Sin asignar' ? (language === 'en' ? 'Unassigned' : 'Sin asignar') : topExpenseCategory}`}
        subtitle={dt.topExpenseHistory}
      >
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={topExpenseCategoryData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(128,128,128,0.12)" />
            <XAxis dataKey="month" stroke="#888780" fontSize={10} axisLine={false} tickLine={false} />
            <YAxis stroke="#888780" fontSize={10} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
            <Tooltip formatter={(value: string | number) => formatCurrency(Number(value))} />
            <Bar
              dataKey="Monto" fill={PALETTE.morado}
              name={topExpenseCategory === 'Sin asignar' ? (language === 'en' ? 'Unassigned' : 'Sin asignar') : topExpenseCategory}
              radius={[4, 4, 0, 0]} barSize={18}
            />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>

      {/* Chart 7: Gastos recurrentes principales por mes */}
      <ChartBox title={dt.topRecurrentExpenses} subtitle={dt.topRecurrentHistory}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={recurrentExpensesData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(128,128,128,0.12)" />
            <XAxis dataKey="month" stroke="#888780" fontSize={10} axisLine={false} tickLine={false} />
            <YAxis stroke="#888780" fontSize={10} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
            <Tooltip formatter={(value: string | number) => formatCurrency(Number(value))} />
            <Legend verticalAlign="top" height={36} iconType="circle" />
            {top3ExpenseCategories.map((cat, idx) => {
              const colors = [PALETTE.azul, PALETTE.rojo, PALETTE.ambar];
              return (
                <Bar
                  key={cat} dataKey={cat} stackId="a" fill={colors[idx % colors.length]}
                  name={cat === 'Sin asignar' ? (language === 'en' ? 'Unassigned' : 'Sin asignar') : cat}
                  radius={idx === top3ExpenseCategories.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                />
              );
            })}
            {top3ExpenseCategories.length === 0 && (
              <Bar dataKey="Sin asignar" fill={PALETTE.gris} name={dt.noExpensesToClassify} />
            )}
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>

      {/* Chart 8: Tendencia de principales fuentes de ingresos */}
      <ChartBox title={dt.topIncomeTrends} subtitle={dt.topIncomeTrendsHistory}>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={platformIncomeData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(128,128,128,0.12)" />
            <XAxis dataKey="month" stroke="#888780" fontSize={10} axisLine={false} tickLine={false} />
            <YAxis stroke="#888780" fontSize={10} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
            <Tooltip formatter={(value: string | number) => formatCurrency(Number(value))} />
            <Legend verticalAlign="top" height={36} iconType="circle" />
            {top3IncomeCategories.map((cat, idx) => {
              const colors = [PALETTE.verde, PALETTE.azul, PALETTE.morado];
              return (
                <Line
                  key={cat} type="monotone" dataKey={cat} stroke={colors[idx % colors.length]}
                  strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }}
                  name={cat === 'Sin asignar' ? (language === 'en' ? 'Unassigned' : 'Sin asignar') : cat}
                />
              );
            })}
            {top3IncomeCategories.length === 0 && (
              <Line type="monotone" dataKey="Sin asignar" stroke={PALETTE.gris} name={dt.noIncomeToClassify} />
            )}
          </LineChart>
        </ResponsiveContainer>
      </ChartBox>

      {/* Chart 9: Saldo Promedio Mensual */}
      <ChartBox title={dt.avgMonthlyBalance} subtitle={dt.avgDailyBalanceDesc}>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={monthlyAggregatedData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(128,128,128,0.12)" />
            <XAxis dataKey="monthLabel" stroke="#888780" fontSize={10} axisLine={false} tickLine={false} />
            <YAxis stroke="#888780" fontSize={10} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
            <Tooltip formatter={(value: string | number) => formatCurrency(Number(value))} contentStyle={tooltipStyle} />
            <ReferenceLine
              y={15000} stroke={PALETTE.rojo} strokeWidth={1.5} strokeDasharray="6 4"
              label={{
                value: language === 'en' ? 'Minimum Threshold $15,000' : 'Umbral Mínimo $15,000',
                position: 'top', fill: PALETTE.rojo, fontSize: 10, fontWeight: 'bold',
              }}
            />
            <Bar dataKey="promedio" radius={[4, 4, 0, 0]} barSize={20}>
              {monthlyAggregatedData.map((entry, index) => {
                const val = entry.promedio;
                let color = PALETTE.rojo;
                if (val >= 20000) color = PALETTE.verde;
                else if (val >= 14000) color = PALETTE.ambar;
                return <Cell key={`cell-${index}`} fill={color} />;
              })}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>

      {/* Chart 10: Composición de ingresos */}
      <ChartBox
        title={`${language === 'en' ? 'Composition: ' : 'Composición: '}${topIncomeCategory === 'Sin asignar' ? (language === 'en' ? 'Unassigned' : 'Sin asignar') : topIncomeCategory}${language === 'en' ? ' vs Rest' : ' vs Resto'}`}
        subtitle={dt.mainIncomeVsOthers}
      >
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={rentasVsOperacionesData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(128,128,128,0.12)" />
            <XAxis dataKey="month" stroke="#888780" fontSize={10} axisLine={false} tickLine={false} />
            <YAxis stroke="#888780" fontSize={10} axisLine={false} tickLine={false} tickFormatter={(v) => `$${v / 1000}k`} />
            <Tooltip formatter={(value: string | number) => formatCurrency(Number(value))} />
            <Legend verticalAlign="top" height={36} iconType="circle" />
            <Bar
              dataKey="Rentas" stackId="a" fill={PALETTE.verde}
              name={topIncomeCategory === 'Sin asignar' ? (language === 'en' ? 'Unassigned' : 'Sin asignar') : topIncomeCategory}
            />
            <Bar dataKey="Operaciones" stackId="a" fill={PALETTE.morado} name={dt.otherIncome} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </ChartBox>
    </div>
  );
}
