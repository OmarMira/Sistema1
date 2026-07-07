import * as Sentry from '@sentry/nextjs';

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1, // Captura el 10% de las transacciones para balancear costo/visibilidad
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0, // Captura el 100% de sesiones con error
  integrations: [
    Sentry.replayIntegration({
      maskAllText: false, // Permitir ver texto en replays para debugging contable
      blockAllMedia: true,
    }),
  ],
});

// Instrument client-side navigation transitions
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
