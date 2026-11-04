/** Decode transport base64 into bytes, never into a UTF-8 JavaScript string. */
export function backupDownloadBlob(encoded: string): Blob {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new Error('Missing backup data');
  }
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: 'application/json' });
}

/** Browser event-handler only: no database or server imports in this module. */
export function downloadBackup(encoded: string, filename: string): void {
  const blob = backupDownloadBlob(encoded);
  const url = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | undefined;
  try {
    anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    try {
      anchor?.remove();
    } finally {
      // Keep the URL alive until the browser has processed the click.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }
  }
}
