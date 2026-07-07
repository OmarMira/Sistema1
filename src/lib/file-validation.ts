import { ValidationError } from './api-error';

const MAGIC_BYTES: Record<string, { bytes: number[]; offset: number }[]> = {
  pdf: [{ bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], offset: 0 }], // %PDF-
  ofx: [
    { bytes: [0x4f, 0x46, 0x58, 0x48, 0x45, 0x41, 0x44, 0x45, 0x52], offset: 0 }, // OFXHEADER
    { bytes: [0x3c, 0x3f, 0x78, 0x6d, 0x6c], offset: 0 }, // <?xml
  ],
  qfx: [
    { bytes: [0x4f, 0x46, 0x58, 0x48, 0x45, 0x41, 0x44, 0x45, 0x52], offset: 0 }, // OFXHEADER
    { bytes: [0x3c, 0x3f, 0x78, 0x6d, 0x6c], offset: 0 }, // <?xml
  ],
};

const ALLOWED_EXTENSIONS = ['pdf', 'csv', 'ofx', 'qfx', 'tsv', 'txt'];

const ALLOWED_MIME_TYPES: Record<string, string[]> = {
  pdf: ['application/pdf'],
  csv: ['text/csv', 'text/plain', 'application/csv'],
  ofx: ['application/x-ofx', 'text/plain', 'application/octet-stream'],
  qfx: ['application/x-qfx', 'application/octet-stream', 'text/plain'],
  tsv: ['text/tab-separated-values', 'text/plain'],
  txt: ['text/plain'],
};

export function validateFileExtension(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
    throw new ValidationError(
      `Formato de archivo no soportado: .${ext}. Los formatos soportados son: ${ALLOWED_EXTENSIONS.join(', ')}`,
    );
  }
  return ext;
}

export function validateFileMimeType(ext: string, mimeType: string): void {
  const allowed = ALLOWED_MIME_TYPES[ext];
  if (!allowed) return;
  if (mimeType && mimeType !== 'application/octet-stream' && !allowed.includes(mimeType)) {
    throw new ValidationError(
      `Tipo MIME no válido para .${ext}: ${mimeType}. Se esperaba: ${allowed.join(', ')}`,
    );
  }
}

export function validateMagicBytes(ext: string, buffer: Buffer): void {
  const signatures = MAGIC_BYTES[ext];
  if (!signatures) return;

  const matches = signatures.some(({ bytes, offset }) => {
    if (buffer.length < offset + bytes.length) return false;
    for (let i = 0; i < bytes.length; i++) {
      if (buffer[offset + i] !== bytes[i]) return false;
    }
    return true;
  });

  if (!matches) {
    const expected = signatures
      .map((s) => `0x${s.bytes.map((b) => b.toString(16).padStart(2, '0')).join('')}`)
      .join(' or ');
    throw new ValidationError(
      `El archivo .${ext} no tiene una cabecera válida. Se esperaba: ${expected}`,
    );
  }
}

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

export function validateFile(file: File, buffer: Buffer): string {
  if (file.size > MAX_FILE_SIZE || buffer.length > MAX_FILE_SIZE) {
    throw new ValidationError(`El archivo excede el tamaño máximo permitido de 20MB.`);
  }
  const ext = validateFileExtension(file.name);
  validateFileMimeType(ext, file.type);
  validateMagicBytes(ext, buffer);
  return ext;
}
