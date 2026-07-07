/**
 * Normaliza descripciones bancarias eliminando campos volátiles
 * (IDs de transacción, números de confirmación, etc.) antes de
 * aplicar fuzzy matching. Calibrado para extractos Bank of America.
 */
export function normalizeBankDescription(raw: string): string {
  return raw
    .replace(/Conf#\s*[\w]+/gi, '') // Referencias Zelle (Conf#T0YKY6RCL o Conf# T0YKY6RCL)
    .replace(/\bID:[\w]+/gi, '') // IDs ACH/WEB (ID:M4884, ID:2057245)
    .replace(/CO ID:[\d\s]+/gi, '') // CO ID bancarios (CO ID:1133133497)
    .replace(/DES:[^\s]+/gi, '') // Etiquetas de red (DES:ACH PMT)
    .replace(/INDN:[^C]+(?=\s|$)/gi, (m) => m) // Preservar nombre beneficiario
    .replace(/[^\w\s]/g, ' ') // Reemplaza símbolos por espacio
    .replace(/\s+/g, ' ') // Colapsa espacios múltiples
    .trim()
    .toLowerCase();
}
