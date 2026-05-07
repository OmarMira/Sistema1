/**
 * PDF Parser for Bank Statement Import
 *
 * Extracts text from PDF bank statements and parses transactions.
 * Supports various bank statement layouts from different banks worldwide.
 * Uses pdf-parse for text extraction, then applies pattern-matching
 * heuristics to identify transaction lines (date, description, amount).
 */

import { PDFParse } from 'pdf-parse';

export interface ParsedTransaction {
  date: Date;
  description: string;
  amount: number;
  reference?: string;
}

export interface ParsedPDF {
  bankName: string;
  transactions: ParsedTransaction[];
  startDate?: Date;
  endDate?: Date;
  openingBalance?: number;
  closingBalance?: number;
}

// ─── Main export ─────────────────────────────────────────────────────

export async function parsePDF(buffer: Buffer, fileName?: string): Promise<ParsedPDF> {
  // 1. Extract text from PDF using pdf-parse v2 class-based API
  let text = '';

  try {
    const pdf = new PDFParse({ data: new Uint8Array(buffer) });
    const textResult = await pdf.getText();
    text = textResult.text || '';
    await pdf.destroy();
  } catch {
    // Fallback: try using the raw Buffer
    try {
      const pdf = new PDFParse({ data: buffer as unknown as ArrayBuffer });
      const textResult = await pdf.getText();
      text = textResult.text || '';
      await pdf.destroy();
    } catch (extractError) {
      throw new Error(
        'Failed to extract text from this PDF. The file may be corrupted, password-protected, or contain only images (scanned). ' +
        'Please export your bank statement as CSV or OFX format instead.'
      );
    }
  }

  if (!text.trim()) {
    throw new Error(
      'No text could be extracted from this PDF. The file may be a scanned image. ' +
      'Please export your bank statement as CSV or OFX format, or use a statement with ' +
      'selectable text.'
    );
  }

  // 2. Parse transactions from extracted text
  const transactions = extractTransactions(text);

  if (transactions.length === 0) {
    throw new Error(
      'No transactions could be identified in this PDF bank statement. ' +
      'The format may not be supported. Try exporting as CSV or OFX instead.'
    );
  }

  // 3. Sort by date ascending
  transactions.sort((a, b) => a.date.getTime() - b.date.getTime());

  // 4. Extract bank name
  const bankName = extractBankName(text, fileName) || 'Imported PDF Statement';

  // 5. Try to extract dates and balances from the text
  const startDate = transactions[0].date;
  const endDate = transactions[transactions.length - 1].date;
  const { openingBalance, closingBalance } = extractBalances(text, transactions);

  return {
    bankName,
    transactions,
    startDate,
    endDate,
    openingBalance,
    closingBalance,
  };
}

// ─── Transaction Extraction ──────────────────────────────────────────

/**
 * Core extraction logic. Tries multiple strategies to find transaction lines.
 * Each strategy targets a different PDF bank statement layout.
 */
function extractTransactions(text: string): ParsedTransaction[] {
  // Clean up the text: normalize whitespace, remove page headers/footers
  const cleaned = normalizeText(text);

  // Strategy 1: Try tabular/structured format (most common)
  let txns = tryTabularExtraction(cleaned);
  if (txns.length >= 2) return txns;

  // Strategy 2: Try line-by-line with date prefix
  txns = tryLineByLineExtraction(cleaned);
  if (txns.length >= 2) return txns;

  // Strategy 3: Try multi-column layout (amounts on the right side)
  txns = tryRightAlignedExtraction(cleaned);
  if (txns.length >= 2) return txns;

  // Strategy 4: Aggressive — find any line with date + number
  txns = tryAggressiveExtraction(cleaned);
  if (txns.length >= 1) return txns;

  return [];
}

// ─── Text Normalization ──────────────────────────────────────────────

function normalizeText(text: string): string {
  let result = text;

  // Remove common PDF artifacts
  result = result.replace(/\f/g, '\n\n');           // form feed → double newline
  result = result.replace(/\r\n/g, '\n');           // normalize line endings
  result = result.replace(/\r/g, '\n');
  result = result.replace(/\t/g, '  ');             // tabs → spaces
  result = result.replace(/ {3,}/g, '  ');         // collapse multiple spaces to 2
  result = result.replace(/^\s+$/gm, '');           // remove blank lines

  // Remove common header/footer noise
  result = result.replace(/(?:Page\s+\d+\s*of\s*\d+)/gi, '');
  result = result.replace(/(?:Página\s+\d+)/gi, '');
  result = result.replace(/(?:Continuation|Continuación|Confidential|Privado)/gi, '');
  result = result.replace(/(?:Statement\s+of\s+Account|Estado\s+de\s+Cuenta)/gi, '');

  // Remove pdf-parse v2 page separator lines: "-- N of M --"
  result = result.replace(/^\s*--\s*\d+\s+of\s+\d+\s*--\s*$/gm, '');

  return result;
}

// ─── Strategy 1: Tabular Extraction ──────────────────────────────────
// Targets: Bank statements that look like tables with date | description | debit | credit columns

function tryTabularExtraction(text: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Try to match: DATE  DESCRIPTION  AMOUNT  [BALANCE]
    // Various date formats at the start of the line
    const dateMatch = line.match(
      /^(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{2,4})\s+(.+)$/i
    );

    if (!dateMatch) continue;

    const dateStr = dateMatch[1];
    const rest = dateMatch[2].trim();

    const date = parseFlexibleDate(dateStr);
    if (!date) continue;

    // Try to find amounts in the rest of the line
    const parsed = extractAmountsFromLine(rest);
    if (parsed) {
      transactions.push({
        date,
        description: parsed.description,
        amount: parsed.amount,
      });
    }
  }

  return deduplicateTransactions(transactions);
}

// ─── Strategy 2: Line-by-Line with Date Prefix ──────────────────────
// Targets: Statements where each transaction is on a single line starting with a date

function tryLineByLineExtraction(text: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Date pattern: MM/DD/YYYY, DD/MM/YYYY, MM-DD-YYYY, YYYY-MM-DD, DD Mon YYYY, etc.
  const dateRegex = /^(?:\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{2,4}|\d{1,2}\s+(?:Ene|Feb|Mar|Abr|May|Jun|Jul|Ago|Sep|Oct|Nov|Dic)\s+\d{2,4})/i;

  for (const line of lines) {
    const m = line.match(dateRegex);
    if (!m) continue;

    const date = parseFlexibleDate(m[0]);
    if (!date) continue;

    // Remove the date prefix from the line
    const rest = line.slice(m[0].length).trim();

    // Skip if the rest is too short (likely a header/date-only line)
    if (rest.length < 3) continue;

    // Skip known non-transaction keywords
    if (/^(?:Date|Fecha|From|Since|Opening|Starting|Closing|Ending|Total|Subtotal|Balance|Saldo)/i.test(rest)) {
      continue;
    }

    const parsed = extractAmountsFromLine(rest);
    if (parsed) {
      transactions.push({
        date,
        description: parsed.description,
        amount: parsed.amount,
      });
    }
  }

  return deduplicateTransactions(transactions);
}

// ─── Strategy 3: Right-Aligned Amount Extraction ────────────────────
// Targets: Multi-column layouts where amounts are right-aligned (common in formal bank statements)

function tryRightAlignedExtraction(text: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Find lines that end with a number (possible amount) and start with a date
    // Pattern: ...description...   -123.45  or  ...description...   123.45  456.78
    const trailingAmount = line.match(
      /^(.+?)\s+(-?\s*\d[\d,]*\.?\d{0,2})\s*$/
    );

    if (!trailingAmount) continue;

    const beforeAmount = trailingAmount[1].trim();
    const amountStr = trailingAmount[2].replace(/\s/g, '');

    // Check if the beginning of the line has a date
    const dateMatch = beforeAmount.match(
      /^(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2}|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{2,4})\s+(.+)$/i
    );

    if (!dateMatch) continue;

    const date = parseFlexibleDate(dateMatch[1]);
    if (!date) continue;

    const description = dateMatch[2].trim();
    const amount = parseAmountValue(amountStr);

    if (description.length >= 2 && !isNaN(amount) && amount !== 0) {
      transactions.push({
        date,
        description,
        amount,
      });
    }
  }

  return deduplicateTransactions(transactions);
}

// ─── Strategy 4: Aggressive Extraction ──────────────────────────────
// Last resort: any line with a date and at least one number

function tryAggressiveExtraction(text: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  for (const line of lines) {
    // Must contain a date
    const dateMatch = line.match(
      /(\d{1,2}[/\-.]\d{1,2}[/\-.]\d{2,4}|\d{4}[/\-.]\d{1,2}[/\-.]\d{1,2})/
    );
    if (!dateMatch) continue;

    // Must contain at least one number that could be an amount
    const amountMatch = line.match(/(-?\s*\d[\d,]*\.\d{2})\b/);
    if (!amountMatch) continue;

    const date = parseFlexibleDate(dateMatch[1]);
    if (!date) continue;

    const amount = parseAmountValue(amountMatch[1]);
    if (isNaN(amount) || amount === 0) continue;

    // Extract description: everything between date and amount
    const dateIdx = line.indexOf(dateMatch[0]);
    const amountIdx = line.indexOf(amountMatch[0]);
    let description = '';

    if (dateIdx >= 0 && amountIdx > dateIdx) {
      description = line.slice(dateIdx + dateMatch[0].length, amountIdx).trim();
    } else {
      description = line.slice(dateIdx + dateMatch[0].length).replace(/-?\s*\d[\d,]*\.\d{2}/, '').trim();
    }

    // Clean description
    description = description.replace(/\s{2,}/g, ' ').trim();

    if (description.length >= 2) {
      transactions.push({
        date,
        description,
        amount,
      });
    }
  }

  return deduplicateTransactions(transactions);
}

// ─── Amount Extraction from a line (after date is removed) ──────────

interface AmountParseResult {
  description: string;
  amount: number;
}

function extractAmountsFromLine(rest: string): AmountParseResult | null {
  // Try pattern: description   debit   credit   [balance]
  // Common: description   123.45  (single amount)
  // Common: description   100.00  50.00  (debit/credit columns)
  // Common: description   -123.45  (negative for debits)

  // First, try to find amounts at the end of the line
  // Match 1 or 2 amounts at the end
  const amountsAtEnd = rest.match(/^(.+?)\s+(-?\s*\d[\d,]*\.?\d{0,2})(?:\s+(-?\s*\d[\d,]*\.?\d{0,2}))?\s*$/);

  if (amountsAtEnd) {
    let description = amountsAtEnd[1].trim();
    const amt1 = parseAmountValue(amountsAtEnd[2].replace(/\s/g, ''));
    const amt2 = amountsAtEnd[3] ? parseAmountValue(amountsAtEnd[3].replace(/\s/g, '')) : null;

    // If there are two amounts, one is debit and one is credit
    if (amt2 !== null && !isNaN(amt2)) {
      // Positive amount (credit) - negative or zero amount (debit)
      const amount = amt1 !== 0 ? amt1 : -amt2;
      if (amount !== 0) {
        return { description, amount };
      }
    }

    // Single amount
    if (!isNaN(amt1) && amt1 !== 0 && description.length >= 2) {
      return { description, amount: amt1 };
    }
  }

  // Try: amount somewhere in the line with parentheses for negatives
  const parenAmount = rest.match(/^(.+?)\s*\(?\s*(\d[\d,]*\.\d{2})\s*\)?\s*(?:Cr|Dr|DB|CR)?\s*$/i);
  if (parenAmount) {
    const description = parenAmount[1].trim();
    const isNegative = rest.includes('(') && rest.includes(')');
    const amount = parseAmountValue(parenAmount[2]) * (isNegative ? -1 : 1);
    if (description.length >= 2 && !isNaN(amount) && amount !== 0) {
      return { description, amount };
    }
  }

  return null;
}

// ─── Date Parsing (Flexible) ────────────────────────────────────────

function parseFlexibleDate(val: string): Date | null {
  const cleaned = val.trim();

  // YYYY-MM-DD
  const isoMatch = cleaned.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return new Date(y, m - 1, d);
    }
  }

  // DD/MM/YYYY or MM/DD/YYYY or DD-MM-YYYY etc.
  const slashMatch = cleaned.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (slashMatch) {
    const a = Number(slashMatch[1]);
    const b = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);

    // If first part > 12, must be DD/MM/YYYY
    if (a > 12) {
      return new Date(year, b - 1, a);
    }
    // If second part > 12, must be MM/DD/YYYY
    if (b > 12) {
      return new Date(year, a - 1, b);
    }
    // Ambiguous — use MM/DD/YYYY (US default)
    return new Date(year, a - 1, b);
  }

  // DD Mon YYYY (e.g., 15 Jan 2026, 15 Ene 2026)
  const monthNames = [
    'jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
    'ene', 'abr', 'ago', 'dic', // Spanish
  ];
  const monthMap: Record<string, number> = {
    'jan': 0, 'ene': 0, 'feb': 1, 'mar': 2, 'abr': 3, 'apr': 3,
    'may': 4, 'jun': 5, 'jul': 6, 'aug': 7, 'ago': 7,
    'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11, 'dic': 11,
  };

  const textMatch = cleaned.match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$/i);
  if (textMatch) {
    const monthKey = textMatch[2].toLowerCase().slice(0, 3);
    const monthIdx = monthMap[monthKey];
    if (monthIdx !== undefined) {
      return new Date(Number(textMatch[3]), monthIdx, Number(textMatch[1]));
    }
  }

  // YYYYMMDD (compact, no separators)
  const compactMatch = cleaned.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    const [, y, m, d] = compactMatch.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return new Date(y, m - 1, d);
    }
  }

  // Fallback
  const fallback = new Date(cleaned);
  return isNaN(fallback.getTime()) ? null : fallback;
}

// ─── Amount Parsing ─────────────────────────────────────────────────

function parseAmountValue(val: string): number {
  let cleaned = val.replace(/\s/g, '');

  // Remove currency symbols
  cleaned = cleaned.replace(/[$€£¥₹₿R$]/g, '');

  // Handle parentheses as negative: (123.45) → -123.45
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }

  // Handle European format: 1.234,56 → 1234.56
  if (cleaned.includes(',') && cleaned.includes('.')) {
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    if (lastComma > lastDot) {
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    }
  } else if (cleaned.includes(',') && !cleaned.includes('.')) {
    // Could be European decimal or thousand separator
    // If pattern like 1234,56 → European decimal
    if (/^\d{1,3},\d{2}$/.test(cleaned)) {
      cleaned = cleaned.replace(',', '.');
    } else if (/,(\d{3}(?:,|$))/.test(cleaned)) {
      // Thousand separator: 1,234 or 1,234,567
      cleaned = cleaned.replace(/,/g, '');
    } else {
      // Ambiguous — assume decimal if ends with 2 digits after comma
      const parts = cleaned.split(',');
      if (parts.length === 2 && parts[1].length <= 2) {
        cleaned = cleaned.replace(',', '.');
      } else {
        cleaned = cleaned.replace(/,/g, '');
      }
    }
  }

  // Remove multiple minus signs (keep only leading)
  cleaned = cleaned.replace(/(?!^)-/g, '');

  const num = parseFloat(cleaned);
  return isNaN(num) ? NaN : num;
}

// ─── Bank Name Extraction ───────────────────────────────────────────

function extractBankName(text: string, fileName?: string): string | null {
  // Try to find bank name from the first few lines (usually in the header)
  const lines = text.split('\n').slice(0, 15).map(l => l.trim()).filter(Boolean);

  // Common bank name patterns
  const bankPatterns = [
    /\b(Bank\s+of\s+America|Chase|JPMorgan|Wells\s+Fargo|Citibank|Citi|HSBC|BNP\s+Paribas|Santander|BBVA|Banco\s+\w+|Banorte|Scotiabank|TD\s+Canada|Royal\s+Bank|Deutsche\s+Bank|Barclays|Lloyds|Standard\s+\w+|Fidelity|Schwab|Vanguard|Capital\s+One|US\s+Bank|PNC\s+Bank|TD\s+Bank|SunTrust|Regions\s+Bank|Ally\s+Bank|Discover|American\s+Express|PayPal|Venmo|Cash\s+App)\b/i,
    /\b(Banco\s+(?:Nación|Provincia|Ciudad|Galicia|Macro|Patagonia|Hipotecario|Comafi|Supervielle|Santander|Río|Itaú|Pampa))\b/i,
    /\b(Banco\s+(?:Estado|Chile|Bice|Bci|Santander|Itaú|Scotiabank|Falabella))\b/i,
    /\b(Banco\s+(?: Nacional|Azteca|Banamex|Bancomer|Santander|BBVA|Scotiabank|Inbursa|HSBC|Afirme))\b/i,
    /\b(Banco\s+(?:Popular|BHD|Banreservas|Scotiabank|Progress))\b/i,
  ];

  for (const line of lines) {
    for (const pattern of bankPatterns) {
      const match = line.match(pattern);
      if (match) {
        return match[1].trim();
      }
    }
  }

  // Try from filename
  if (fileName) {
    const base = fileName.replace(/\.[^.]+$/, '');
    const parts = base.split(/[-_\s]+/).filter(Boolean);

    const bankKeywords = [
      'chase', 'bank', 'wells', 'fargo', 'citi', 'america', 'bofa',
      'hsbc', 'paypal', 'venmo', 'cashapp', 'santander', 'bbva',
      'banorte', 'scotiabank', 'bancolombia', 'bcp', 'interbank',
      'galicia', 'macro', 'nacion', 'santander', 'itau', 'bancomer',
      'banamex', 'estado', 'bice', 'bci',
    ];

    const matchingParts = parts.filter(p =>
      bankKeywords.some(kw => p.toLowerCase().includes(kw))
    );

    if (matchingParts.length > 0) {
      return matchingParts
        .map(p => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
        .join(' ');
    }
  }

  return null;
}

// ─── Balance Extraction ─────────────────────────────────────────────

function extractBalances(
  text: string,
  transactions: ParsedTransaction[]
): { openingBalance: number; closingBalance: number } {
  let openingBalance = 0;
  let closingBalance = 0;

  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Look for balance indicators
  const openingPatterns = [
    /(?:Opening|Initial|Previous|Beginning|Saldo\s+anterior|Saldo\s+inicial)[:\s]+(-?[\d,]+\.?\d*)/i,
  ];
  const closingPatterns = [
    /(?:Closing|Final|Current|Ending|New|Saldo\s+actual|Saldo\s+final|Total|Balance\s*(?:at|due))[:\s]+(-?[\d,]+\.?\d*)/i,
  ];

  for (const line of lines) {
    for (const pattern of openingPatterns) {
      const match = line.match(pattern);
      if (match) {
        openingBalance = parseAmountValue(match[1]);
      }
    }
    for (const pattern of closingPatterns) {
      const match = line.match(pattern);
      if (match) {
        closingBalance = parseAmountValue(match[1]);
      }
    }
  }

  // Calculate from transactions if not found
  if (closingBalance === 0 && transactions.length > 0) {
    const total = transactions.reduce((s, t) => s + t.amount, 0);
    closingBalance = openingBalance + total;
  } else if (openingBalance === 0 && closingBalance !== 0 && transactions.length > 0) {
    const total = transactions.reduce((s, t) => s + t.amount, 0);
    openingBalance = closingBalance - total;
  }

  return { openingBalance, closingBalance };
}

// ─── Deduplication ──────────────────────────────────────────────────

function deduplicateTransactions(transactions: ParsedTransaction[]): ParsedTransaction[] {
  const seen = new Set<string>();
  const result: ParsedTransaction[] = [];

  for (const txn of transactions) {
    const key = `${txn.date.toISOString().split('T')[0]}|${txn.amount}|${txn.description.substring(0, 40).toUpperCase()}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(txn);
    }
  }

  return result;
}
