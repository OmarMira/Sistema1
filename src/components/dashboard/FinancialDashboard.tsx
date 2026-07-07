'use client';
import { useEffect, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Download, AlertTriangle, CheckCircle, TrendingUp, Wallet } from 'lucide-react';
import { exportToCSV, exportToPDF } from '@/lib/dashboard/export-utils';
import type { DashboardAlert, DashboardTrendPoint } from '@/lib/types/shared';

interface FinancialKPI {
  assets: number;
  liabilities: number;
  equity: number;
  revenue: number;
  expenses: number;
  accountingEquationCheck: string;
}

interface FinancialAlerts {
  pendingReconciliation: number;
  unlockedPastPeriods: number;
  draftsInLockedPeriods: number;
  status: string;
}

interface FinancialData {
  kpi: FinancialKPI;
  alerts: FinancialAlerts;
  monthlyTrend: DashboardTrendPoint[];
}

export function FinancialDashboard({ companyId }: { companyId: string }) {
  const [data, setData] = useState<FinancialData | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/dashboard/financial?companyId=${companyId}`);
    if (res.ok) setData(await res.json());
    setLoading(false);
  }, [companyId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) return <div className="p-6">Cargando panel financiero...</div>;
  if (!data) return <div className="p-6 text-red-500">Error cargando datos</div>;

  const { kpi, alerts, monthlyTrend } = data;

  return (
    <div className="space-y-6 p-6">
      <div className="flex justify-between items-center">
        <h2 className="text-2xl font-bold">Panel Financiero Ejecutivo</h2>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => exportToCSV(kpi, monthlyTrend, companyId)}>
            <Download className="w-4 h-4 mr-2" /> CSV
          </Button>
          <Button
            variant="outline"
            onClick={() => exportToPDF(kpi, alerts as unknown as DashboardAlert[], monthlyTrend, companyId)}
          >
            <Download className="w-4 h-4 mr-2" /> PDF
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Wallet className="w-5 h-5" /> Activos
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">${kpi.assets.toFixed(2)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="w-5 h-5" /> Patrimonio
            </CardTitle>
          </CardHeader>
          <CardContent className="text-2xl font-bold">${kpi.equity.toFixed(2)}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle
                className={`w-5 h-5 ${kpi.accountingEquationCheck === 'PASS' ? 'text-green-500' : 'text-red-500'}`}
              />{' '}
              Ecuación Contable
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Badge variant={kpi.accountingEquationCheck === 'PASS' ? 'default' : 'destructive'}>
              {kpi.accountingEquationCheck}
            </Badge>
          </CardContent>
        </Card>
      </div>

      {/* Alertas */}
      <Card>
        <CardHeader>
          <CardTitle>Estado de Integridad</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div
            className={`p-3 rounded ${alerts.pendingReconciliation > 0 ? 'bg-yellow-50' : 'bg-green-50'}`}
          >
            <p className="text-sm text-gray-500">Conciliaciones Pendientes</p>
            <p className="text-xl font-bold">{alerts.pendingReconciliation}</p>
          </div>
          <div
            className={`p-3 rounded ${alerts.unlockedPastPeriods > 0 ? 'bg-red-50' : 'bg-green-50'}`}
          >
            <p className="text-sm text-gray-500">Períodos Pasados Abiertos</p>
            <p className="text-xl font-bold">{alerts.unlockedPastPeriods}</p>
          </div>
          <div
            className={`p-3 rounded ${alerts.draftsInLockedPeriods > 0 ? 'bg-red-50' : 'bg-green-50'}`}
          >
            <p className="text-sm text-gray-500">Borradores en Período Cerrado</p>
            <p className="text-xl font-bold">{alerts.draftsInLockedPeriods}</p>
          </div>
          <div
            className={`p-3 rounded ${alerts.status === 'HEALTHY' ? 'bg-green-50' : 'bg-yellow-50'}`}
          >
            <p className="text-sm text-gray-500">Estado General</p>
            <p className="text-xl font-bold flex items-center gap-2">
              {alerts.status === 'HEALTHY' ? (
                <CheckCircle className="w-5 h-5 text-green-600" />
              ) : (
                <AlertTriangle className="w-5 h-5 text-yellow-600" />
              )}
              {alerts.status}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
