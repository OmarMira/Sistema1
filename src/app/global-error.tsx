'use client';

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="es">
      <body className="flex h-screen items-center justify-center bg-background text-foreground">
        <div className="flex flex-col items-center gap-4 text-center p-6 border rounded-xl bg-card max-w-sm shadow-lg">
          <div className="flex size-12 items-center justify-center rounded-full bg-rose-100 dark:bg-rose-950/50 text-rose-600">
            <svg className="size-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold">Ocurrió un error inesperado</h2>
            <p className="text-xs text-muted-foreground mt-1">
              La aplicación ha detectado un fallo en el entorno raíz. Puedes intentar recargar.
            </p>
          </div>
          <button
            onClick={() => reset()}
            className="w-full rounded-lg bg-primary py-2 text-sm font-semibold text-primary-foreground shadow transition-colors hover:bg-primary/90"
          >
            Reintentar
          </button>
        </div>
      </body>
    </html>
  );
}
