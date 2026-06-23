import { describe, it, expect } from 'vitest';
import { parseCSV } from '@/lib/csv-parser';

describe('parseCSV()', () => {
  // ── Basic CSV parsing ───────────────────────────────────────────

  it('parses comma-delimited CSV with standard headers', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,Zelle payment to LAURA QUIJANO,-500.00',
      '01/16/2025,UBER TRIP,25.50',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(2);
    expect(result[0].description).toBe('Zelle payment to LAURA QUIJANO');
    expect(result[0].amount).toBe(-500.0);
    expect(result[1].description).toBe('UBER TRIP');
    expect(result[1].amount).toBe(25.5);
  });

  it('parses semicolon-delimited CSV', () => {
    const csv = [
      'Date;Description;Amount',
      '03/01/2025;HOME DEPOT;150.75',
      '03/02/2025;AMAZON;89.99',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(2);
    expect(result[0].amount).toBe(150.75);
    expect(result[1].amount).toBe(89.99);
  });

  it('parses tab-delimited CSV', () => {
    const csv = 'Date\tDescription\tAmount\n01/15/2025\tWALMART\t200.00';

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('WALMART');
    expect(result[0].amount).toBe(200.0);
  });

  // ── Date formats ────────────────────────────────────────────────

  it('parses YYYY-MM-DD dates', () => {
    const csv = [
      'Date,Description,Amount',
      '2025-03-15,Payment to LAURA QUIJANO,500.00',
    ].join('\n');

    const result = parseCSV(csv);
    const expected = new Date(2025, 2, 15); // March 15 (month is 0-indexed)
    expect(result[0].date.getFullYear()).toBe(expected.getFullYear());
    expect(result[0].date.getMonth()).toBe(expected.getMonth());
    expect(result[0].date.getDate()).toBe(expected.getDate());
  });

  it('parses MM/DD/YYYY dates', () => {
    const csv = [
      'Date,Description,Amount',
      '03/15/2025,Payment to LAURA QUIJANO,500.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].date.getMonth()).toBe(2); // March
    expect(result[0].date.getDate()).toBe(15);
  });

  it('parses DD/MM/YYYY dates (day > 12)', () => {
    const csv = [
      'Date,Description,Amount',
      '25/12/2025,Christmas payment,100.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].date.getMonth()).toBe(11); // December
    expect(result[0].date.getDate()).toBe(25);
  });

  it('parses DD Mon YYYY dates', () => {
    const csv = [
      'Date,Description,Amount',
      '15 Jan 2025,Payment,100.00',
      '03 Feb 2025,Payment,200.00',
      '15 Mar 2025,Payment,300.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].date.getMonth()).toBe(0); // Jan
    expect(result[0].date.getDate()).toBe(15);
    expect(result[1].date.getMonth()).toBe(1); // Feb
    expect(result[2].date.getMonth()).toBe(2); // Mar
  });

  // ── Amount formats ──────────────────────────────────────────────

  it('parses negative amounts with - sign', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,Expense,-150.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].amount).toBe(-150.0);
  });

  it('parses negative amounts in parentheses', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,Expense,(200.00)',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].amount).toBe(-200.0);
  });

  it('parses European format 1.234,56 (comma decimal, dot thousands)', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,Expense,"1.234,56"',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].amount).toBe(1234.56);
  });

  it('parses US format 1,234.56 (comma thousands)', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,Income,"1,234.56"',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].amount).toBe(1234.56);
  });

  it('parses amounts with currency symbols', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,Payment,$500.00',
      '01/16/2025,Payment,€200.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].amount).toBe(500.0);
    expect(result[1].amount).toBe(200.0);
  });

  it('parses amounts with trailing comma as decimal', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,Payment,1234,',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].amount).toBe(1234);
  });

  it('parses amounts with comma as decimal separator in semicolon CSV', () => {
    const csv = [
      'Date;Description;Amount',
      '01/15/2025;Payment;1234,56',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].amount).toBe(1234.56);
  });

  // ── Quoted fields ───────────────────────────────────────────────

  it('handles quoted descriptions containing commas', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,"Zelle payment to LAURA QUIJANO, thanks",500.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].description).toBe('Zelle payment to LAURA QUIJANO, thanks');
  });

  it('handles escaped quotes inside quoted fields', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,"Note ""URGENT"" payment",100.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].description).toBe('Note "URGENT" payment');
  });

  // ── Header variants ─────────────────────────────────────────────

  it('parses with Spanish headers (fecha, descripcion, monto)', () => {
    const csv = [
      'fecha,descripcion,monto',
      '15/01/2025,Pago a proveedor,1500.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].description).toBe('Pago a proveedor');
    expect(result[0].amount).toBe(1500.0);
  });

  it('includes reference column when present', () => {
    const csv = [
      'Date,Description,Amount,Reference',
      '01/15/2025,Payment,500.00,REF12345',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result[0].reference).toBe('REF12345');
  });

  // ── Skip invalid rows ──────────────────────────────────────────

  it('skips comment lines starting with #', () => {
    const csv = [
      'Date,Description,Amount',
      '# This is a comment',
      '01/15/2025,Payment,100.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
  });

  it('skips comment lines starting with //', () => {
    const csv = [
      'Date,Description,Amount',
      '// This is a comment',
      '01/15/2025,Payment,100.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
  });

  it('skips blank lines', () => {
    const csv = [
      'Date,Description,Amount',
      '',
      '01/15/2025,Payment,100.00',
      '',
      '01/16/2025,Payment,200.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(2);
  });

  it('skips rows with too few columns', () => {
    const csv = [
      'Date,Description,Amount',
      'just one column',
      '01/15/2025,Payment,100.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
  });

  it('skips rows with missing date', () => {
    const csv = [
      'Date,Description,Amount',
      ',Payment,100.00',
      '01/15/2025,Valid payment,50.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(50);
  });

  it('skips rows with missing description', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,,100.00',
      '01/15/2025,Valid payment,50.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(50);
  });

  it('skips rows with invalid date', () => {
    const csv = [
      'Date,Description,Amount',
      'not-a-date,Payment,100.00',
      '01/15/2025,Valid payment,50.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(50);
  });

  it('skips rows with non-numeric amount', () => {
    const csv = [
      'Date,Description,Amount',
      '01/15/2025,Payment,INVALID',
      '01/15/2025,Valid payment,50.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(1);
    expect(result[0].amount).toBe(50);
  });

  // ── Error cases ────────────────────────────────────────────────

  it('throws on CSV with only a header row', () => {
    const csv = 'Date,Description,Amount';
    expect(() => parseCSV(csv)).toThrow('must contain at least a header row');
  });

  it('throws on CSV with missing required columns', () => {
    const csv = [
      'Name,Age,Location',
      'John,30,NYC',
    ].join('\n');
    expect(() => parseCSV(csv)).toThrow('Could not detect column mapping');
  });

  it('throws on completely empty content', () => {
    expect(() => parseCSV('')).toThrow('must contain at least a header row');
  });

  // ── Line endings ──────────────────────────────────────────────

  it('handles \\r\\n line endings', () => {
    const csv = 'Date,Description,Amount\r\n01/15/2025,Payment,100.00\r\n01/16/2025,Payment,200.00';

    const result = parseCSV(csv);
    expect(result).toHaveLength(2);
  });

  // ── Realistic bank CSVs ─────────────────────────────────────────

  it('parses multiple transactions in a single batch', () => {
    const csv = [
      'Date,Description,Amount',
      '01/01/2025,SALARY DEPOSIT,5000.00',
      '01/02/2025,RENT PAYMENT,-1500.00',
      '01/03/2025,UBER EATS,-25.00',
      '01/04/2025,AMAZON PURCHASE,-89.99',
      '01/05/2025,FREELANCE INCOME,750.00',
    ].join('\n');

    const result = parseCSV(csv);
    expect(result).toHaveLength(5);
    expect(result.reduce((sum, t) => sum + t.amount, 0)).toBeCloseTo(4135.01, 2);
  });
});
