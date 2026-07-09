export const AI_CONFIG = {
  DEFAULT_MODEL: 'openrouter/free',
  LEGACY_MODEL: 'deepseek/deepseek-chat',
  BASE_URL: 'https://openrouter.ai/api/v1',
  AVAILABLE_MODELS: [
    { id: 'openrouter/free', name: 'Enrutador Gratis (Recomendado - 100% Gratis)', isFree: true, baseUrl: 'https://openrouter.ai/api/v1' },
    { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B (Pago - Ultra Barato)', isFree: false, baseUrl: 'https://openrouter.ai/api/v1' },
    { id: 'qwen/qwen3.7-plus', name: 'Qwen 3.7 Plus (Pago - Modelo Insignia)', isFree: false, baseUrl: 'https://openrouter.ai/api/v1' },
    { id: 'custom', name: 'Otro Modelo (Personalizado)', isFree: false, baseUrl: 'https://openrouter.ai/api/v1' },
  ],
} as const;
