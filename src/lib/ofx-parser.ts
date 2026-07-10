/**
 * OFX/QFX Parser for Bank Statement Import
 *
 * Supports both SGML (OFX v1) and XML (OFX v2+) formats.
 * Extracts bank information, account details, balances, and transactions.
 */

export interface ParsedTransaction {
  date: Date;
  description: string;
  amount: number;
  reference?: string;
}

export interface ParsedOFX {
  bankName: string;
  accountNumber: string;
  transactions: ParsedTransaction[];
  startDate: Date;
  endDate: Date;
  openingBalance: number;
  closingBalance: number;
}

// ─── Main export ─────────────────────────────────────────────────────

export function parseOFX(content: string): ParsedOFX {
  // Determine format: XML vs SGML
  const trimmed = content.trim();

  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<OFX>')) {
    return parseXML(trimmed);
  }

  // Try to extract and convert SGML
  return parseSGML(trimmed);
}

// ─── XML Parser (OFX v2) ────────────────────────────────────────────

function parseXML(content: string): ParsedOFX {
  // Use DOMParser-like regex extraction for Node.js compatibility
  const bankName =
    extractXmlValue(content, 'BANKNAME') || extractXmlValue(content, 'ORG') || 'Unknown Bank';
  const accountNumber = extractXmlValue(content, 'ACCTID') || '';
  const acctType = extractXmlValue(content, 'ACCTTYPE') || 'CHECKING';

  // Balances
  const ledgerBal = extractXmlValue(content, 'LEDGERBAL') || extractXmlValue(content, 'AVAILBAL');
  const balAmount = ledgerBal ? (extractXmlValue(ledgerBal, 'BALAMT') ?? '0') : '0';
  const closingBalance = parseFloat(balAmount) || 0;

  const startDateVal = extractXmlValue(content, 'DTSTART');
  const endDateVal = extractXmlValue(content, 'DTEND');

  // Extract transactions
  const transactions = extractTransactionsXML(content);

  if (transactions.length === 0) {
    throw new Error('No transactions found in OFX file');
  }

  // Sort by date
  transactions.sort((a, b) => a.date.getTime() - b.date.getTime());

  const startDate = startDateVal ? parseOFXDate(startDateVal) : transactions[0]!.date;
  const endDate = endDateVal
    ? parseOFXDate(endDateVal)
    : transactions[transactions.length - 1]!.date;

  // Calculate opening balance from closing balance
  const totalCredits = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totalDebits = transactions
    .filter((t) => t.amount < 0)
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  const openingBalance = closingBalance - totalCredits + totalDebits;

  return {
    bankName: `${bankName} (${acctType})`,
    accountNumber,
    transactions,
    startDate,
    endDate,
    openingBalance,
    closingBalance,
  };
}

function extractTransactionsXML(content: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];

  // Match all <STMTTRN>...</STMTTRN> blocks
  const trnRegex = /<STMTTRN>[\s\S]*?<\/STMTTRN>/gi;
  const matches = content.match(trnRegex);

  if (!matches) return transactions;

  for (const block of matches) {
    const type = extractXmlValue(block, 'TRNTYPE') || '';
    const datePosted = extractXmlValue(block, 'DTPOSTED');
    const amount = extractXmlValue(block, 'TRNAMT');
    const fitId = extractXmlValue(block, 'FITID');
    const name = extractXmlValue(block, 'NAME') || extractXmlValue(block, 'PAYEE') || '';

    if (!datePosted || !amount) continue;

    const date = parseOFXDate(datePosted);
    const amt = parseFloat(amount);

    if (isNaN(date.getTime()) || isNaN(amt)) continue;

    transactions.push({
      date,
      description: name || `${type} ${fitId || ''}`.trim(),
      amount: amt,
      reference: fitId || undefined,
    });
  }

  return transactions;
}

// ─── SGML Parser (OFX v1) ────────────────────────────────────────────

function parseSGML(content: string): ParsedOFX {
  // Remove OFX header
  const headerEnd = content.indexOf('<');
  const body = headerEnd > -1 ? content.slice(headerEnd) : content;

  // Extract bank info
  const bankName =
    extractTagValue(body, 'BANKNAME') || extractTagValue(body, 'ORG') || 'Unknown Bank';
  const accountNumber = extractTagValue(body, 'ACCTID') || '';
  const acctType = extractTagValue(body, 'ACCTTYPE') || 'CHECKING';

  // Balances
  const balAmountStr = extractTagValue(body, 'BALAMT');
  const closingBalance = balAmountStr ? parseFloat(balAmountStr) : 0;

  // Date range
  const startDateStr = extractTagValue(body, 'DTSTART');
  const endDateStr = extractTagValue(body, 'DTEND');

  // Extract transactions from STMTRS block
  const transactions = extractTransactionsSGML(body);

  if (transactions.length === 0) {
    throw new Error('No transactions found in OFX/QFX file');
  }

  // Sort by date
  transactions.sort((a, b) => a.date.getTime() - b.date.getTime());

  const startDate = startDateStr ? parseOFXDate(startDateStr) : transactions[0]!.date;
  const endDate = endDateStr
    ? parseOFXDate(endDateStr)
    : transactions[transactions.length - 1]!.date;

  // Calculate opening balance
  const totalCredits = transactions.filter((t) => t.amount > 0).reduce((s, t) => s + t.amount, 0);
  const totalDebits = transactions
    .filter((t) => t.amount < 0)
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  const openingBalance = closingBalance - totalCredits + totalDebits;

  return {
    bankName: `${bankName} (${acctType})`,
    accountNumber,
    transactions,
    startDate,
    endDate,
    openingBalance,
    closingBalance,
  };
}

function extractTransactionsSGML(content: string): ParsedTransaction[] {
  const transactions: ParsedTransaction[] = [];

  // Find all STMTTRN blocks
  const trnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  const matches = content.match(trnRegex);

  if (!matches) return transactions;

  for (const block of matches) {
    const type = extractTagValue(block, 'TRNTYPE') || '';
    const datePosted = extractTagValue(block, 'DTPOSTED');
    const amount = extractTagValue(block, 'TRNAMT');
    const fitId = extractTagValue(block, 'FITID');
    const name = extractTagValue(block, 'NAME') || extractTagValue(block, 'PAYEE') || '';

    if (!datePosted || !amount) continue;

    const date = parseOFXDate(datePosted);
    const amt = parseFloat(amount);

    if (isNaN(date.getTime()) || isNaN(amt)) continue;

    transactions.push({
      date,
      description: name || `${type} ${fitId || ''}`.trim(),
      amount: amt,
      reference: fitId || undefined,
    });
  }

  return transactions;
}

// ─── Helpers ─────────────────────────────────────────────────────────

function extractTagValue(content: string, tag: string): string | null {
  // Match <TAG>value</TAG> or <TAG>value (until next <)
  const opening = `<${tag}>`;
  const closing = `</${tag}>`;

  const startIdx = content.indexOf(opening);
  if (startIdx === -1) return null;

  const valueStart = startIdx + opening.length;

  const closeIdx = content.indexOf(closing, valueStart);
  if (closeIdx !== -1) {
    return content.slice(valueStart, closeIdx).trim();
  }

  // For SGML: no closing tag, take until next <
  const nextTag = content.indexOf('<', valueStart);
  if (nextTag !== -1) {
    return content.slice(valueStart, nextTag).trim();
  }

  return content.slice(valueStart).trim();
}

function extractXmlValue(content: string, tag: string): string | null {
  // Handle nested XML extraction
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = content.match(regex);
  if (match) return match[1]!.trim();

  // Fallback: self-closing or attribute-style
  const attrRegex = new RegExp(`<${tag}[^>]*?>([^<]*)`, 'i');
  const attrMatch = content.match(attrRegex);
  return attrMatch ? attrMatch[1]!.trim() : null;
}

// ─── OFX Date Parsing ────────────────────────────────────────────────

function parseOFXDate(val: string): Date {
  if (!val) return new Date();

  // Clean the value: remove timezone info like [-5:EST] or [-5.0:GMT]
  const cleaned = val.replace(/\[.*?\]/g, '').trim();

  // OFX format: YYYYMMDDHHMMSS or YYYYMMDD
  // Sometimes YYYYMMDDHHMMSS.XXX
  const dateStr = cleaned.replace(/[^0-9]/g, '').slice(0, 14);

  if (dateStr.length < 8) return new Date();

  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(4, 6), 10) - 1;
  const day = parseInt(dateStr.slice(6, 8), 10);
  const hour = dateStr.length >= 10 ? parseInt(dateStr.slice(8, 10), 10) : 0;
  const minute = dateStr.length >= 12 ? parseInt(dateStr.slice(10, 12), 10) : 0;
  const second = dateStr.length >= 14 ? parseInt(dateStr.slice(12, 14), 10) : 0;

  return new Date(year, month, day, hour, minute, second);
}
