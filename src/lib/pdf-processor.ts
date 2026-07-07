import { ParsedPDFResult, parsePDF } from './pdf-parser';

export function parsePDFAsync(
  buffer: Buffer,
  options?: { fileName?: string; companyId?: string; userId?: string },
): Promise<ParsedPDFResult> {
  // Always run in-thread on the server side to avoid Webpack worker bundling and path issues
  return parsePDF(buffer, options);
}
