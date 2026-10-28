import { getAiConfig } from '@/lib/ai-config';
import { AiConfigMissingError, ImportAiError } from '@/lib/ai-import-error';
import {
  AiProviderReconfigurationError,
  providerIdForCanonicalBaseUrl,
} from '@/lib/constants/ai-config';

/** Use the installation's configured provider, never implicit SDK credentials. */
export async function requestImportProfile(
  systemPrompt: string,
  userPrompt: string,
  timeoutMs: number,
): Promise<string> {
  let config;
  try {
    config = await getAiConfig();
  } catch (error) {
    if (error instanceof AiConfigMissingError) throw new ImportAiError('AI_CONFIG_MISSING');
    if (error instanceof AiProviderReconfigurationError) {
      throw new ImportAiError('AI_PROVIDER_RECONFIGURATION_REQUIRED');
    }
    throw new ImportAiError('AI_CONFIG_UNAVAILABLE');
  }

  const providerId = providerIdForCanonicalBaseUrl(config.baseUrl);
  if (!providerId) throw new ImportAiError('AI_PROVIDER_RECONFIGURATION_REQUIRED');
  const anthropic = providerId === 'anthropic';
  const openrouter = providerId === 'openrouter';
  const messages = [{ role: 'user', content: userPrompt }];
  const body = {
    model: config.model,
    max_tokens: openrouter ? 4096 : 1500,
    temperature: 0,
    // A free router must select a provider that actually supports JSON mode.
    ...(openrouter ? {
      response_format: { type: 'json_object' },
      provider: { require_parameters: true },
    } : {}),
    ...(anthropic
      ? { system: systemPrompt, messages }
      : { messages: [{ role: 'system', content: systemPrompt }, ...messages] }),
  };

  try {
    const response = await fetch(`${config.baseUrl}/${anthropic ? 'messages' : 'chat/completions'}`, {
      method: 'POST',
      headers: anthropic
        ? { 'Content-Type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' }
        : { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
    if (!response.ok) {
      const reason = response.status === 401 ? 'credentials_rejected'
        : response.status === 402 ? 'credits_required'
        : response.status === 429 ? 'rate_limited' : 'provider_rejected';
      throw new ImportAiError('AI_PROVIDER_UNAVAILABLE', { reason, providerStatus: response.status });
    }
    const data = await response.json();
    if (data.choices?.[0]?.finish_reason === 'length' || data.stop_reason === 'max_tokens') {
      throw new ImportAiError('AI_PROFILE_GENERATION_FAILED', { reason: 'response_truncated' });
    }
    const content = anthropic
      ? data.content?.filter((part: { type?: string; text?: unknown }) => part.type === 'text' && typeof part.text === 'string')
          .map((part: { text: string }) => part.text).join('\n')
      : data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ImportAiError('AI_PROFILE_GENERATION_FAILED', { reason: 'empty_response' });
    }
    return content;
  } catch (error) {
    if (error instanceof ImportAiError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
      throw new ImportAiError('AI_PROVIDER_UNAVAILABLE', { reason: 'timeout' });
    }
    throw new ImportAiError('AI_PROVIDER_UNAVAILABLE');
  }
}
