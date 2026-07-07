/**
 * Sanitiza una cadena eliminando cualquier tag HTML.
 * NO HTML-escapa entidades — React ya escapa en el frontend,
 * y escapar en el servidor rompe caracteres como &, <, > en los datos.
 */
export function sanitizeInput(value: string): string {
  if (!value) return value;
  // 1. Remueve bloques <script>...</script> enteros (tags + contenido)
  // 2. Remueve cualquier otro tag HTML individual, preservando el texto
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<[^>]*>/g, '');
}
