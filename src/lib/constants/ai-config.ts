export const AI_PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter (Gratis)', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openrouter/free' },
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', defaultModel: 'deepseek-chat' },
  { id: 'anthropic', name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', defaultModel: 'claude-sonnet-4-20250514' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini' },
  { id: 'google', name: 'Google (Gemini)', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.0-flash' },
  { id: 'custom', name: 'Otro proveedor', baseUrl: '', defaultModel: '' },
] as const;

export type ProviderId = (typeof AI_PROVIDERS)[number]['id'];

export const AI_CONFIG = {
  DEFAULT_MODEL: 'openrouter/free',
  LEGACY_MODEL: 'deepseek/deepseek-chat',
  BASE_URL: 'https://openrouter.ai/api/v1',
  AVAILABLE_MODELS: [
    { id: 'openrouter/free', name: 'Enrutador Gratis (Recomendado - 100% Gratis)', isFree: true },
    { id: 'qwen/qwen-2.5-72b-instruct', name: 'Qwen 2.5 72B (Pago - Ultra Barato)', isFree: false },
    { id: 'qwen/qwen3.7-plus', name: 'Qwen 3.7 Plus (Pago - Modelo Insignia)', isFree: false },
    { id: 'custom', name: 'Otro Modelo (Personalizado)', isFree: false },
  ],
} as const;
