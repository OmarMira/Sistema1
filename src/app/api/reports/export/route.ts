import { NextRequest, NextResponse } from 'next/server';
import { apiHandler } from '@/lib/api-handler';
import { db } from '@/lib/db';
import { requireCompanyContext } from '@/lib/context-storage';
import { toUTCRange } from '@/lib/reports/date-filter';
import { aggregateFinancialData } from '@/lib/reports/aggregation';
import { exportToCSVContent, type TrialBalanceData, type IncomeStatementData, type BalanceSheetData } from '@/lib/reports/export-csv';
import { generateHash } from '@/lib/reports/integrity';

export const GET = apiHandler(async (req: NextRequest) => {
  const { userId, companyId } = requireCompanyContext();

  const { searchParams } = new URL(req.url);
  const type = searchParams.get('type') || '';
  const format = searchParams.get('format') || 'csv';
  const startDateStr = searchParams.get('startDate');
  const endDateStr = searchParams.get('endDate');

  if (!type) {
    return NextResponse.json({ error: 'companyId y type son requeridos' }, { status: 400 });
  }

  try {
    const { startDate, endDate } = toUTCRange(startDateStr, endDateStr);

    // 1. Obtener datos agregados
    const data = await aggregateFinancialData(companyId, startDate, endDate, type);

    // 2. Generar el payload del reporte a firmar
    const reportPayload = {
      type,
      format,
      companyId,
      dateRange: { start: startDate.toISOString(), end: endDate.toISOString() },
      data,
      exportedAt: new Date().toISOString(),
    };

    // 3. Generar el hash de integridad criptográfico pre-render
    const hash = generateHash(reportPayload);

    // 4. Registrar auditoría
    await db.auditLog.create({
      data: {
        companyId,
        userId,
        action: 'REPORT_EXPORTED',
        entity: 'Company',
        entityId: companyId,
        details: JSON.stringify({
          type,
          format,
          startDate: startDate.toISOString(),
          endDate: endDate.toISOString(),
          hash,
        }),
      },
    });

    if (format === 'csv') {
      const csvContent = exportToCSVContent(data as TrialBalanceData | IncomeStatementData | BalanceSheetData, companyId, type, hash);
      const response = new NextResponse(csvContent);
      response.headers.set('Content-Type', 'text/csv; charset=utf-8');
      response.headers.set(
        'Content-Disposition',
        `attachment; filename="reporte-${type}-${companyId}-${Date.now()}.csv"`,
      );
      response.headers.set('X-Integrity-Hash', hash);
      return response;
    }

    // PDF Mock o exportación nativa
    if (format === 'pdf') {
      // Como el usuario solicitó validar primero el formato sin agregar dependencias pesadas que requieran compilar de inmediato,
      // retornamos un JSON estructurado con tipo de contenido PDF que se puede firmar o simular.
      const pdfText =
        `LQ&OM LLC - REPORTE FINANCIERO INTERNO PDF MOCK\n` +
        `Empresa ID: ${companyId}\n` +
        `Tipo: ${type.toUpperCase()}\n` +
        `Hash de Integridad SHA-256: ${hash}\n` +
        `ADVERTENCIA: DOCUMENTO PARA USO INTERNO. NO VÁLIDO PARA PRESENTACIÓN OFICIAL.`;

      const response = new NextResponse(pdfText);
      response.headers.set('Content-Type', 'application/pdf');
      response.headers.set(
        'Content-Disposition',
        `attachment; filename="reporte-${type}-${companyId}-${Date.now()}.pdf"`,
      );
      response.headers.set('X-Integrity-Hash', hash);
      return response;
    }

    throw new Error('Formato no soportado');
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
});
