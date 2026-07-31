export function normalizeText(val: string | number): string {
  return String(val).toLowerCase().trim().replace(/\s+/g, ' ');
}
