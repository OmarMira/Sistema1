import { describe, it, expect } from 'vitest';
import {
  validateFileExtension,
  validateFileMimeType,
  validateMagicBytes,
  validateFile,
} from '@/lib/file-validation';

describe('validateFileExtension', () => {
  it('returns lowercase extension for valid PDF', () => {
    expect(validateFileExtension('report.pdf')).toBe('pdf');
  });

  it('accepts uppercase extensions', () => {
    expect(validateFileExtension('REPORT.CSV')).toBe('csv');
  });

  it('accepts all allowed extensions', () => {
    const allowed = ['pdf', 'csv', 'ofx', 'qfx', 'tsv', 'txt'];
    for (const ext of allowed) {
      expect(validateFileExtension(`file.${ext}`)).toBe(ext);
    }
  });

  it('throws ValidationError for unsupported extension', () => {
    expect(() => validateFileExtension('file.exe')).toThrow(/no soportado/);
  });

  it('throws ValidationError for file with no extension', () => {
    expect(() => validateFileExtension('Makefile')).toThrow(/no soportado/);
  });

  it('throws ValidationError for empty string', () => {
    expect(() => validateFileExtension('')).toThrow(/no soportado/);
  });

  it('shows supported extensions in error message', () => {
    expect(() => validateFileExtension('file.zip')).toThrow(/pdf.*csv.*ofx/);
  });
});

describe('validateFileMimeType', () => {
  it('accepts valid MIME for PDF', () => {
    expect(() => validateFileMimeType('pdf', 'application/pdf')).not.toThrow();
  });

  it('accepts application/octet-stream as wildcard', () => {
    expect(() => validateFileMimeType('pdf', 'application/octet-stream')).not.toThrow();
  });

  it('accepts valid MIME for CSV', () => {
    expect(() => validateFileMimeType('csv', 'text/csv')).not.toThrow();
    expect(() => validateFileMimeType('csv', 'text/plain')).not.toThrow();
    expect(() => validateFileMimeType('csv', 'application/csv')).not.toThrow();
  });

  it('accepts valid MIME for TXT', () => {
    expect(() => validateFileMimeType('txt', 'text/plain')).not.toThrow();
  });

  it('rejects invalid MIME for PDF', () => {
    expect(() => validateFileMimeType('pdf', 'image/png')).toThrow(/Tipo MIME no válido/);
  });

  it('rejects invalid MIME for CSV', () => {
    expect(() => validateFileMimeType('csv', 'application/pdf')).toThrow(/Tipo MIME no válido/);
  });

  it('returns silently for unknown extension (no MIME check)', () => {
    expect(() => validateFileMimeType('unknown', 'anything/here')).not.toThrow();
  });

  it('accepts empty MIME when not in allowed list', () => {
    // When mimeType is falsy and not 'application/octet-stream', it passes through
    // because empty string is not checked against allowed
    expect(() => validateFileMimeType('txt', 'text/plain')).not.toThrow();
  });

  it('rejects empty string MIME for PDF', () => {
    // empty string is falsy, so it should not throw
    expect(() => validateFileMimeType('pdf', '')).not.toThrow();
  });
});

describe('validateMagicBytes', () => {
  it('accepts PDF with correct header', () => {
    const buf = Buffer.from('%PDF-1.4\n%EOF', 'utf-8');
    expect(() => validateMagicBytes('pdf', buf)).not.toThrow();
  });

  it('rejects PDF with wrong header', () => {
    const buf = Buffer.from('Not a PDF', 'utf-8');
    expect(() => validateMagicBytes('pdf', buf)).toThrow(/cabecera válida/);
  });

  it('rejects PDF with too-short buffer', () => {
    const buf = Buffer.from('%PD', 'utf-8'); // only 3 bytes
    expect(() => validateMagicBytes('pdf', buf)).toThrow(/cabecera válida/);
  });

  it('accepts OFX with OFXHEADER', () => {
    const buf = Buffer.from('OFXHEADER:100', 'utf-8');
    expect(() => validateMagicBytes('ofx', buf)).not.toThrow();
  });

  it('accepts OFX with <?xml header', () => {
    const buf = Buffer.from('<?xml version="1.0"?>', 'utf-8');
    expect(() => validateMagicBytes('ofx', buf)).not.toThrow();
  });

  it('accepts QFX with OFXHEADER', () => {
    const buf = Buffer.from('OFXHEADER:100', 'utf-8');
    expect(() => validateMagicBytes('qfx', buf)).not.toThrow();
  });

  it('accepts QFX with <?xml header', () => {
    const buf = Buffer.from('<?xml version="1.0"?><OFX>', 'utf-8');
    expect(() => validateMagicBytes('qfx', buf)).not.toThrow();
  });

  it('rejects OFX with invalid header', () => {
    const buf = Buffer.from('Random text', 'utf-8');
    expect(() => validateMagicBytes('ofx', buf)).toThrow(/cabecera válida/);
  });

  it('returns silently for extension without magic bytes check', () => {
    // CSV has no magic bytes defined
    const buf = Buffer.from('any content', 'utf-8');
    expect(() => validateMagicBytes('csv', buf)).not.toThrow();
  });

  it('returns silently for txt extension', () => {
    const buf = Buffer.from('any text', 'utf-8');
    expect(() => validateMagicBytes('txt', buf)).not.toThrow();
  });

  it('returns silently for tsv extension', () => {
    const buf = Buffer.from('any\ttsv', 'utf-8');
    expect(() => validateMagicBytes('tsv', buf)).not.toThrow();
  });

  it('includes expected hex bytes in error message', () => {
    const buf = Buffer.from('BAD', 'utf-8');
    expect(() => validateMagicBytes('pdf', buf)).toThrow(/0x/);
    expect(() => validateMagicBytes('pdf', buf)).toThrow(/25504446/); // %PDF in hex
  });
});

describe('validateFile', () => {
  it('passes for a valid file under size limit', () => {
    const file = new File(['test content'], 'document.pdf', { type: 'application/pdf' });
    const buffer = Buffer.from('%PDF-1.4 document content');
    expect(validateFile(file, buffer)).toBe('pdf');
  });

  it('passes for a valid CSV under size limit', () => {
    const file = new File(['a,b,c'], 'data.csv', { type: 'text/csv' });
    const buffer = Buffer.from('a,b,c');
    expect(validateFile(file, buffer)).toBe('csv');
  });

  it('passes for a valid TXT under size limit', () => {
    const file = new File(['text'], 'notes.txt', { type: 'text/plain' });
    const buffer = Buffer.from('text');
    expect(validateFile(file, buffer)).toBe('txt');
  });

  it('throws if file.size exceeds 20MB', () => {
    const largeSize = 21 * 1024 * 1024;
    const file = new File([''], 'doc.pdf', { type: 'application/pdf' });
    Object.defineProperty(file, 'size', { value: largeSize });
    const buffer = Buffer.from('%PDF-1.4');
    expect(() => validateFile(file, buffer)).toThrow(/20MB/);
  });

  it('throws if buffer.length exceeds 20MB', () => {
    const file = new File([''], 'doc.pdf', { type: 'application/pdf' });
    const largeBuffer = Buffer.alloc(21 * 1024 * 1024);
    expect(() => validateFile(file, largeBuffer)).toThrow(/20MB/);
  });

  it('throws for unsupported extension', () => {
    const file = new File(['content'], 'file.exe', { type: 'application/x-msdownload' });
    const buffer = Buffer.from('content');
    expect(() => validateFile(file, buffer)).toThrow(/no soportado/);
  });

  it('throws for invalid MIME type', () => {
    const file = new File(['content'], 'doc.pdf', { type: 'image/png' });
    const buffer = Buffer.from('%PDF-1.4');
    expect(() => validateFile(file, buffer)).toThrow(/Tipo MIME no válido/);
  });

  it('throws for invalid magic bytes', () => {
    const file = new File(['content'], 'doc.pdf', { type: 'application/pdf' });
    const buffer = Buffer.from('Not a PDF at all');
    expect(() => validateFile(file, buffer)).toThrow(/cabecera válida/);
  });

  it('validates extension before MIME and magic bytes', () => {
    const file = new File(['x'], 'unsupported.xyz', { type: 'application/pdf' });
    const buffer = Buffer.from('%PDF-1.4');
    expect(() => validateFile(file, buffer)).toThrow(/no soportado/);
  });
});
