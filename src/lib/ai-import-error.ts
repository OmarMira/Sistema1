import { AppError } from '@/lib/api-error';

/** Keeps the resolver's existing public message and generic Error behavior. */
export class AiConfigMissingError extends Error {
  constructor() {
    super('AI configuration missing. Set AI_API_KEY in .env or save via /api/config/ai.');
  }
}

const messages = {
  AI_CONFIG_MISSING: 'Configurá la IA para interpretar este documento.',
  AI_CONFIG_UNAVAILABLE: 'No se pudo leer la configuración de IA. Revisá la configuración o contactá al administrador.',
  AI_PROVIDER_RECONFIGURATION_REQUIRED: 'Volvé a guardar la configuración seleccionando un proveedor de IA permitido.',
  AI_PROVIDER_UNAVAILABLE: 'El proveedor de IA no pudo completar la lectura. Revisá la conexión, la cuenta y el modelo antes de reintentar.',
  AI_PROFILE_GENERATION_FAILED: 'La IA no pudo generar una lectura válida de este documento. No se importaron movimientos de este archivo.',
} as const;

export type ImportAiErrorCode = keyof typeof messages;

export type ImportAiFailureReason =
  | 'credentials_rejected' | 'credits_required' | 'rate_limited'
  | 'provider_rejected' | 'timeout' | 'empty_response' | 'response_truncated';

/** Safe, actionable failures: never include keys, prompts or provider bodies. */
export class ImportAiError extends AppError {
  constructor(code: ImportAiErrorCode, details?: {
    reason: ImportAiFailureReason;
    providerStatus?: number;
  }) {
    super(503, messages[code], code, details);
  }
}
