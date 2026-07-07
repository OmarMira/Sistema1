export function validateLlmOutput(rawText: string, parsedTransactions: unknown[]): string[] {
  const errors: string[] = [];

  for (let i = 0; i < parsedTransactions.length; i++) {
    const txn = parsedTransactions[i] as Record<string, unknown>;
    if (!txn || typeof txn !== 'object') continue;

    const fieldsToCheck = ['amount', 'debit', 'credit', 'reference', 'balance'];

    for (const field of fieldsToCheck) {
      const value = txn[field];
      if (value === undefined || value === null) continue;

      const strValue = String(value);

      // Skip non-monetary fields (short references can be anything)
      if (field === 'reference' && strValue.length < 3) continue;

      // Normalize both for comparison (remove spaces, normalize decimals)
      const normalizedValue = strValue.replace(/\s+/g, '').replace(/,/g, '.');
      const normalizedText = rawText.replace(/\s+/g, '').replace(/,/g, '.');

      // For monetary fields, check the value exists verbatim in the raw text
      if (field === 'amount' || field === 'debit' || field === 'credit') {
        if (!normalizedText.includes(normalizedValue)) {
          errors.push(
            `Transaction ${i}: ${field} value "${strValue}" not found verbatim in source PDF text. Possible hallucination.`,
          );
        }
      }
    }
  }

  return errors;
}
