export function validateSemanticDirection(
  accountType: string,
  direction: 'debit' | 'credit',
  description: string,
): string | null {
  if (!accountType || !direction || !description) {
    return null;
  }

  const descLower = description.toLowerCase();

  if (accountType === 'equity') {
    if (direction === 'debit') {
      const keywords = [
        'retiro',
        'socio',
        'capital',
        'draw',
        'partner',
        'owner',
        'distribucion',
        'dividendo',
        'utilidades',
        'aporte',
        'disminucion',
      ];
      const hasKeyword = keywords.some((kw) => descLower.includes(kw));
      if (!hasKeyword) {
        return 'Advertencia semántica: La cuenta de patrimonio registra un débito pero la descripción no contiene palabras clave asociadas a retiro, socio o disminución de capital.';
      }
    }
  } else if (accountType === 'revenue') {
    if (direction === 'debit') {
      const keywords = [
        'devolucion',
        'reembolso',
        'refund',
        'return',
        'cancelacion',
        'extorno',
        'rebaja',
        'descuento',
        'ajuste',
      ];
      const hasKeyword = keywords.some((kw) => descLower.includes(kw));
      if (!hasKeyword) {
        return 'Advertencia semántica: La cuenta de ingresos registra un débito pero la descripción no contiene palabras clave de devolución, reembolso o descuento.';
      }
    }
  } else if (accountType === 'expense') {
    if (direction === 'credit') {
      const keywords = [
        'reembolso',
        'abono',
        'refund',
        'credit',
        'ajuste',
        'devolucion',
        'extorno',
        'reversar',
        'nota de credito',
      ];
      const hasKeyword = keywords.some((kw) => descLower.includes(kw));
      if (!hasKeyword) {
        return 'Advertencia semántica: La cuenta de gastos o costos registra un crédito pero la descripción no contiene palabras clave de reembolso, abono o ajuste.';
      }
    }
  }

  return null;
}
