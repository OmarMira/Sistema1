const MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
};

const REGEX = /[&<>"']/g;

export function escapeHtml(str: string): string {
  return str.replace(REGEX, (ch) => MAP[ch]);
}
