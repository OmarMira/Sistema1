'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { FileText, Download, AlertTriangle } from 'lucide-react';

interface ReportExportModalProps {
  isOpen: boolean;
  onClose: () => void;
  companyId: string;
}

export function ReportExportModal({ isOpen, onClose, companyId }: ReportExportModalProps) {
  const [type, setType] = useState<string>('trial_balance');
  const [format, setFormat] = useState<string>('csv');
  const [startDate, setStartDate] = useState<string>('2025-01-01');
  const [endDate, setEndDate] = useState<string>('2025-05-31');
  const [loading, setLoading] = useState<boolean>(false);

  const handleExport = () => {
    setLoading(true);
    const params = new URLSearchParams({
      companyId,
      type,
      format,
      startDate,
      endDate,
    });

    // Disparar la descarga en una ventana nueva de forma segura
    window.open(`/api/reports/export?${params.toString()}`, '_blank');
    setLoading(false);
    onClose();
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-primary" />
            Exportar Reportes Financieros
          </DialogTitle>
          <DialogDescription>
            Genera y descarga balances contables auditados en formato CSV o PDF firmado.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Tipo de Reporte */}
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="type" className="text-right text-sm font-medium">
              Reporte
            </Label>
            <div className="col-span-3">
              <Select value={type} onValueChange={setType}>
                <SelectTrigger id="type">
                  <SelectValue placeholder="Seleccionar reporte" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="trial_balance">Balanza de Comprobación</SelectItem>
                  <SelectItem value="income_statement">Estado de Resultados (P&L)</SelectItem>
                  <SelectItem value="balance_sheet">Balance General</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Formato */}
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="format" className="text-right text-sm font-medium">
              Formato
            </Label>
            <div className="col-span-3">
              <Select value={format} onValueChange={setFormat}>
                <SelectTrigger id="format">
                  <SelectValue placeholder="Seleccionar formato" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">CSV (Con Hash SHA-256)</SelectItem>
                  <SelectItem value="pdf">PDF Firmado (Uso Interno)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Fechas */}
          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="startDate" className="text-right text-sm font-medium">
              Desde
            </Label>
            <input
              id="startDate"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="col-span-3 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <div className="grid grid-cols-4 items-center gap-4">
            <Label htmlFor="endDate" className="text-right text-sm font-medium">
              Hasta
            </Label>
            <input
              id="endDate"
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="col-span-3 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          {/* Advertencia de Uso Interno */}
          <Alert className="bg-amber-50 border-amber-200">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <AlertTitle className="text-amber-800 text-xs font-bold">
              USO INTERNO ÚNICAMENTE
            </AlertTitle>
            <AlertDescription className="text-amber-700 text-xxs leading-tight mt-1">
              Documento de borrador interno. No válido para presentación oficial ante entidades de
              impuestos o gubernamentales.
            </AlertDescription>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancelar
          </Button>
          <Button onClick={handleExport} disabled={loading} className="gap-2">
            <Download className="w-4 h-4" />
            {loading ? 'Exportando...' : 'Exportar Reporte'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
