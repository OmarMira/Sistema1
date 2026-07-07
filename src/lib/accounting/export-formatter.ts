import type { FlowTransaction } from '../../types/accounting-flow';

export function formatFlowToCSV(transactions: FlowTransaction[], companyName: string): string {
  const headers = [
    'ID',
    'Fecha',
    'Descripción',
    'Cuenta Contrapartida',
    'Código Contrapartida',
    'Monto',
    'Tipo',
    'Origen',
    'Compañía',
  ];

  const escapeCSV = (val: string) => {
    const escaped = val.replace(/"/g, '""');
    return `"${escaped}"`;
  };

  const rows = transactions.map((t) => [
    t.id,
    t.date,
    escapeCSV(t.description),
    escapeCSV(t.account),
    t.accountCode,
    t.amount.toFixed(2),
    t.type === 'inflow' ? 'Entrada' : 'Salida',
    t.source === 'journal' ? 'Asiento Contable' : 'Transacción Bancaria',
    escapeCSV(companyName),
  ]);

  return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
}
