/**
 * CSV Parser for Bank Statement Import
 *
 * Auto-detects delimiter (comma, semicolon, tab)
 * Auto-detects date formats (MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD)
 * Parses various amount formats (negative numbers, parentheses, currency symbols)
 */

import { civilDateFromParts } from './accounting/civil-date';

export interface ParsedTransaction {
  date: Date;
  description: string;
  amount: number;
  reference?: string;
}

interface ColumnMapping {
  date: number; // column index for date
  description: number; // column index for description
  amount: number; // column index for amount
  reference?: number; // column index for reference (optional)
}

// ─── Main export ─────────────────────────────────────────────────────

/**
 * Persistable structural mapping of one CSV layout. Field names mirror the
 * CsvLayoutProfile persistence contract exactly.
 */
export interface CsvLayoutMapping {
  delimiter: string;
  dateColumnIndex: number;
  descriptionColumnIndex: number;
  amountColumnIndex: number;
  referenceColumnIndex: number | null;
}

/**
 * Structural identity of a CSV document: real delimiter plus the normalized
 * headers in file order. This is all fingerprinting needs — and all a reuse
 * decision needs BEFORE any column discovery runs.
 */
export interface CsvLayoutStructure {
  delimiter: string;
  orderedNormalizedHeaders: string[];
}

/**
 * Canonical identity of a CSV layout:
 * delimiter + "\n" + orderedNormalizedHeaders.join("\u001F").
 * Deterministic; derives from the same normalization used for discovery.
 */
export function csvLayoutFingerprint(structure: CsvLayoutStructure): string {
  return structure.delimiter + '\n' + structure.orderedNormalizedHeaders.join('\u001F');
}

/**
 * Inspect a CSV's structure: delimiter and ordered normalized headers.
 * Runs NO column discovery (mapColumns is never called here), so a reuse
 * path can fingerprint and look up a stored mapping without discovering.
 * Throws when the document has no header + data rows.
 */
export function inspectCsvLayout(content: string): CsvLayoutStructure {
  const lines = splitIntoLines(content);
  if (lines.length < 2) {
    throw new Error('CSV file must contain at least a header row and one data row');
  }

  const delimiter = detectDelimiter(lines[0]!);
  const orderedNormalizedHeaders = parseLine(lines[0]!, delimiter).map((h) =>
    h
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, ''),
  );

  return { delimiter, orderedNormalizedHeaders };
}

/**
 * Column half of a mapping, as discovered from normalized headers. The
 * delimiter is NOT part of discovery: it comes from structure inspection and
 * is composed by the caller, so no placeholder value can leak into a
 * persisted mapping.
 */
export interface DiscoveredColumnMapping {
  dateColumnIndex: number;
  descriptionColumnIndex: number;
  amountColumnIndex: number;
  referenceColumnIndex: number | null;
}

/**
 * Discover the column mapping for an already-normalized header row.
 * The ONLY place column heuristics (mapColumns) run. Returns null when the
 * headers cannot be mapped.
 */
export function discoverCsvMapping(
  orderedNormalizedHeaders: string[],
): DiscoveredColumnMapping | null {
  const mapping = mapColumns(orderedNormalizedHeaders);
  if (mapping === null) return null;

  return {
    dateColumnIndex: mapping.date,
    descriptionColumnIndex: mapping.description,
    amountColumnIndex: mapping.amount,
    referenceColumnIndex: mapping.reference ?? null,
  };
}

/**
 * Minimal applicability invariant for a stored mapping: every index must be
 * addressable within the actual header width. A mapping that fails this is
 * stale and must be rediscovered.
 */
export function isCsvLayoutMappingApplicable(
  mapping: CsvLayoutMapping,
  headerCount: number,
): boolean {
  if (headerCount <= 0) return false;
  const inRange = (index: number) =>
    Number.isInteger(index) && index >= 0 && index < headerCount;
  return (
    inRange(mapping.dateColumnIndex) &&
    inRange(mapping.descriptionColumnIndex) &&
    inRange(mapping.amountColumnIndex) &&
    (mapping.referenceColumnIndex === null ||
      inRange(mapping.referenceColumnIndex))
  );
}

/**
 * Apply a PROVIDED mapping to CSV content. Never runs discovery: no
 * detectDelimiter, no header normalization, no mapColumns.
 */
export function applyCsvLayout(
  content: string,
  mapping: CsvLayoutMapping,
): ParsedTransaction[] {
  const lines = splitIntoLines(content);
  if (lines.length < 2) throw new Error('CSV file must contain at least a header row and one data row');
  const transactions: ParsedTransaction[] = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw || raw.startsWith('#') || raw.startsWith('//')) continue;
    const cols = parseLine(raw, mapping.delimiter);
    if (cols.length < 2) continue;
    const dateVal = cols[mapping.dateColumnIndex]?.trim();
    const descVal = cols[mapping.descriptionColumnIndex]?.trim();
    const amountVal = cols[mapping.amountColumnIndex]?.trim();
    const refVal =
      mapping.referenceColumnIndex !== null ? cols[mapping.referenceColumnIndex]?.trim() : undefined;
    if (!dateVal || !descVal || amountVal === undefined || amountVal === '') continue;
    const date = parseDate(dateVal);
    if (!date || isNaN(date.getTime())) continue;
    const amount = parseAmount(amountVal);
    if (isNaN(amount)) continue;
    transactions.push({ date, description: descVal, amount, reference: refVal || undefined });
  }
  if (transactions.length === 0) throw new Error('No valid transactions found in CSV file');
  return transactions;
}

export function parseCSV(content: string): ParsedTransaction[] {
  // Legacy entry point: same inspection + discovery + application semantics
  // as the exported pair above (single source of truth).
  const structure = inspectCsvLayout(content);
  const mapping = discoverCsvMapping(structure.orderedNormalizedHeaders);
  if (mapping === null) {
    throw new Error(
      'Could not detect column mapping. Ensure headers include columns for date, description, and amount.',
    );
  }
  return applyCsvLayout(content, { ...mapping, delimiter: structure.delimiter });
}

// ─── Line splitting (handles quoted fields) ──────────────────────────

function splitIntoLines(content: string): string[] {
  // Handle both \r\n and \n — only track quotes to avoid splitting
  // inside quoted fields. Leave escape processing to parseLine().
  const raw = content.replace(/\r\n/g, '\n');
  const lines: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '\n' && !inQuotes) {
      lines.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) lines.push(current);
  return lines;
}

function parseLine(line: string, delimiter: string): string[] {
  const cols: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cols.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cols.push(current.trim());
  return cols;
}

// ─── Delimiter detection ─────────────────────────────────────────────

function detectDelimiter(headerLine: string): string {
  const counts = {
    ',': (headerLine.match(/,/g) || []).length,
    ';': (headerLine.match(/;/g) || []).length,
    '\t': (headerLine.match(/\t/g) || []).length,
  };

  // Return the delimiter with the highest count
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  return best[1] > 0 ? best[0] : ',';
}

// ─── Column mapping ──────────────────────────────────────────────────

const DATE_HEADERS = [
  'date',
  'transactiondate',
  'postingdate',
  'dtPosted',
  'trandate',
  'postdate',
  'fecha',
  'fechaoperacion',
  'fechavalor',
  'valuedate',
];
const DESC_HEADERS = [
  'description',
  'desc',
  'memo',
  'particulars',
  'details',
  'narration',
  'payee',
  'transactiondescription',
  'concepto',
  'descripcion',
  'descripcionmovimiento',
];
const AMOUNT_HEADERS = [
  'amount',
  'transactionamount',
  'withdrawal',
  'deposit',
  'debit',
  'credit',
  'monto',
  'cargo',
  'abono',
  'valor',
  'importe',
];
const REF_HEADERS = [
  'reference',
  'ref',
  'checknumber',
  'chequeno',
  'transactionref',
  'trnref',
  'referencia',
  'nofactura',
  'referencianum',
];

function mapColumns(headers: string[]): ColumnMapping | null {
  const dateIdx = headers.findIndex((h) => DATE_HEADERS.includes(h));
  const descIdx = headers.findIndex((h) => DESC_HEADERS.includes(h));
  const amountIdx = headers.findIndex((h) => AMOUNT_HEADERS.includes(h));
  const refIdx = headers.findIndex((h) => REF_HEADERS.includes(h));

  if (dateIdx === -1 || descIdx === -1 || amountIdx === -1) return null;

  return {
    date: dateIdx,
    description: descIdx,
    amount: amountIdx,
    reference: refIdx !== -1 ? refIdx : undefined,
  };
}

// ─── Date parsing ────────────────────────────────────────────────────

function parseDate(val: string): Date | null {
  // Remove time portion if present
  const dateStr = val.split(/[T\s]/)[0]!.trim();

  // Try YYYY-MM-DD
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(dateStr)) {
    const parts = dateStr.split('-').map(Number);
    return civilDateFromParts(parts[0]!, parts[1]!, parts[2]!);
  }

  // Try MM/DD/YYYY or DD/MM/YYYY
  const slashMatch = dateStr.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (slashMatch) {
    const a = Number(slashMatch[1]);
    const b = Number(slashMatch[2]);
    const year = Number(slashMatch[3]);

    // If first part > 12, it must be DD/MM/YYYY
    if (a > 12) {
      return civilDateFromParts(year, b, a);
    }
    // If second part > 12, it must be MM/DD/YYYY
    if (b > 12) {
      return civilDateFromParts(year, a, b);
    }
    // Ambiguous — default to MM/DD/YYYY (US convention)
    return civilDateFromParts(year, a, b);
  }

  // Try DD Mon YYYY (e.g., 15 Jan 2026). Match against the FULL value: the
  // time-stripping split above truncates text-month dates ("15 Jan 2025" -> "15"),
  // which would otherwise fall through to the local-timezone fallback.
  const monthNames = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
  ];
  const textMatch = val.trim().match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$/);
  if (textMatch) {
    const monthIdx = monthNames.indexOf(textMatch[2]!.toLowerCase().slice(0, 3));
    if (monthIdx !== -1) {
      return civilDateFromParts(Number(textMatch[3]), monthIdx + 1, Number(textMatch[1]));
    }
  }

  // Fallback: parse as UTC to avoid JS local-vs-UTC ambiguity
  // Try ISO-ish format (YYYY-MM-DD) first
  const isoMatch = val.match(/^\s*(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    return civilDateFromParts(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  // Last-resort: JS native parse (local-timezone dependent)
  const fallback = new Date(val);
  return isNaN(fallback.getTime()) ? null : fallback;
}

// ─── Amount parsing ──────────────────────────────────────────────────

function parseAmount(val: string): number {
  // Remove currency symbols, spaces, and letters
  let cleaned = val.replace(/[^0-9.,()\-+]/g, '');

  // Handle parentheses as negative: (123.45) → -123.45
  if (cleaned.startsWith('(') && cleaned.endsWith(')')) {
    cleaned = '-' + cleaned.slice(1, -1);
  }

  // Handle European format: 1.234,56 → 1234.56
  // If last separator is a comma and there are dots as thousand separators
  if (cleaned.includes(',') && cleaned.includes('.')) {
    const lastComma = cleaned.lastIndexOf(',');
    const lastDot = cleaned.lastIndexOf('.');
    if (lastComma > lastDot) {
      // European: 1.234,56
      cleaned = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      // US: 1,234.56
      cleaned = cleaned.replace(/,/g, '');
    }
  } else if (cleaned.endsWith(',')) {
    // Trailing comma as decimal separator: 1234,
    cleaned = cleaned.slice(0, -1);
  } else if (cleaned.includes(',') && !cleaned.includes('.')) {
    // Comma as decimal: 1234,56
    cleaned = cleaned.replace(',', '.');
  }

  // Remove multiple minus signs
  cleaned = cleaned.replace(/(?<!^)-/g, '');

  const num = parseFloat(cleaned);
  return isNaN(num) ? NaN : num;
}
