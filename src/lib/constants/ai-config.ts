export const AI_PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter (Gratis)', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/free' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { id: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { id: 'google', name: 'Google (Gemini)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash' },
] as const;

export type ProviderId = (typeof AI_PROVIDERS)[number]['id'];

export const AI_PROVIDER_IDS: readonly ProviderId[] = AI_PROVIDERS.map((p) => p.id);

// ─── Canonical allowlist (server-side source of truth for egress destinations) ───

const CANONICAL_BASE_URLS: ReadonlySet<string> = new Set(AI_PROVIDERS.map((p) => p.baseUrl));

export class AiProviderReconfigurationError extends Error {
  readonly code = 'AI_PROVIDER_RECONFIGURATION_REQUIRED' as const;

  constructor(
    message = 'The stored AI provider is no longer supported. Select one of the allowed providers and re-save your configuration.',
  ) {
    super(message);
    this.name = 'AiProviderReconfigurationError';
  }
}

export function resolveProviderBaseUrl(providerId: string): string {
  const provider = AI_PROVIDERS.find((p) => p.id === providerId);
  if (!provider || !provider.baseUrl) {
    throw new AiProviderReconfigurationError(`Unknown or unsupported AI provider: '${providerId}'`);
  }
  return provider.baseUrl;
}

export function resolveProviderDefaultModel(providerId: string): string | undefined {
  return AI_PROVIDERS.find((p) => p.id === providerId)?.defaultModel;
}

export function isCanonicalAiBaseUrl(baseUrl: string): boolean {
  return CANONICAL_BASE_URLS.has(baseUrl);
}

export function providerIdForCanonicalBaseUrl(baseUrl: string): ProviderId | null {
  const provider = AI_PROVIDERS.find((p) => p.baseUrl === baseUrl);
  return provider ? provider.id : null;
}

export const AI_CONFIG = {
  DEFAULT_MODEL: 'openrouter/free',
  LEGACY_MODEL: 'deepseek/deepseek-chat',
  BASE_URL: 'https://openrouter.ai/api/v1',
  STORAGE_KEYS: {
    ENCRYPTED_KEY: 'ai_encrypted_key',
    MODEL: 'ai_model',
    BASE_URL: 'ai_base_url',
  },
  STORAGE_KEYS_SET: new Set(['ai_encrypted_key', 'ai_model', 'ai_base_url']),
  AVAILABLE_MODELS: [
    { id: 'openrouter/free', name: 'Enrutador Gratis (Recomendado - 100% Gratis)', isFree: true },
    { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B (Pago - Ultra Barato)', isFree: false },
    { id: 'qwen/qwen3.7-plus', name: 'Qwen 3.7 Plus (Pago - Modelo Insignia)', isFree: false },
    { id: 'custom', name: 'Otro Modelo (Personalizado)', isFree: false },
  ],
} as const;
