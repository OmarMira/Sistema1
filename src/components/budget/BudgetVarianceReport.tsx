'use client';
import { useQuery } from '@tanstack/react-query';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { AlertTriangle, CheckCircle, ArrowUpRight, ArrowDownRight } from 'lucide-react';

export function BudgetVarianceReport({
  companyId,
  year,
  month,
}: {
  companyId: string;
  year: number;
  month: number;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['budget-variance', companyId, year, month],
    queryFn: () =>
      fetch(`/api/budget/compare?companyId=${companyId}&year=${year}&month=${month}`).then((r) =>
        r.json(),
      ),
    enabled: !!companyId,
  });

  if (isLoading) return <div>Cargando análisis presupuestal...</div>;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Análisis de Varianza: {data?.period}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {data?.data.map((row: { accountCode: string; accountName: string; budget: number; actual: number; variance: number; variancePercent: number; status: string }) => (
            <div
              key={row.accountCode}
              className="flex items-center justify-between p-3 rounded border bg-card hover:bg-muted/50"
            >
              <div className="flex items-center gap-3">
                {row.status === 'CRITICAL' ? (
                  <AlertTriangle className="text-red-500" />
                ) : (
                  <CheckCircle className="text-green-500" />
                )}
                <div>
                  <p className="font-medium text-sm">{row.accountName}</p>
                  <p className="text-xs text-muted-foreground">{row.accountCode}</p>
                </div>
              </div>

              <div className="flex items-center gap-6 text-sm font-mono">
                <div className="text-right">
                  <p className="text-muted-foreground text-xs">Presupuesto</p>
                  <p>${row.budget.toFixed(2)}</p>
                </div>
                <div className="text-right">
                  <p className="text-muted-foreground text-xs">Real</p>
                  <p>${row.actual.toFixed(2)}</p>
                </div>
                <div className="text-right w-24">
                  <p className="text-muted-foreground text-xs">Varianza</p>
                  <p
                    className={`flex items-center justify-end gap-1 ${row.variance > 0 ? 'text-red-500' : 'text-green-500'}`}
                  >
                    {row.variance > 0 ? <ArrowUpRight size={14} /> : <ArrowDownRight size={14} />}
                    {Math.abs(row.variancePercent).toFixed(1)}%
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
