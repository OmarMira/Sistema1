import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { requireGlobalAdminRole } from '@/lib/rbac';
import { safeFetch } from '@/lib/security/safe-fetch';
import { getAiConfig, setAiConfig } from '@/lib/ai-config';
import {
  AI_CONFIG,
  AiProviderReconfigurationError,
  isCanonicalAiBaseUrl,
  providerIdForCanonicalBaseUrl,
  resolveProviderBaseUrl,
} from '@/lib/constants/ai-config';
import { logger } from '@/lib/logger';

export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    await requireGlobalAdminRole(userId);

    try {
      const config = await getAiConfig();
      const maskedKey =
        config.apiKey.length > 8
          ? config.apiKey.slice(0, 4) + '...' + config.apiKey.slice(-4)
          : '...';

      logger.info('[AI CONFIG GET]', { model: config.model, baseUrl: config.baseUrl, providerId: config.providerId });

      let aiAlive = false;
      try {
        const verifyRes = await safeFetch(`${config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
          },
          body: JSON.stringify({
            model: config.model || AI_CONFIG.DEFAULT_MODEL,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: 1,
          }),
          signal: AbortSignal.timeout(10000),
        });
        aiAlive = verifyRes.ok || verifyRes.status === 429;
      } catch {
        aiAlive = false;
      }

      return NextResponse.json({
        isSaved: true,
        apiKey: maskedKey,
        model: config.model,
        baseUrl: config.baseUrl,
        providerId: config.providerId,
        aiAlive,
      });
    } catch (err) {
      if (err instanceof AiProviderReconfigurationError) {
        logger.warn('[AI CONFIG GET] Legacy provider requires reconfiguration');
        return NextResponse.json({
          isSaved: true,
          needsReconfiguration: true,
          code: 'AI_PROVIDER_RECONFIGURATION_REQUIRED',
          aiAlive: false,
        });
      }
      logger.error('[AI CONFIG GET] Failed to load config', { error: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ isSaved: false });
    }
  },
  { requireMembership: false },
);

export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    await requireGlobalAdminRole(userId);

    try {
      const { apiKey, model, baseUrl, providerId } = await request.json();
      if (!apiKey) {
        return NextResponse.json({ error: 'La clave no puede estar vacía' }, { status: 400 });
      }

      // Fail closed: a baseUrl supplied by the client must be canonical.
      // An arbitrary baseUrl is never persisted as the network destination.
      if (typeof baseUrl === 'string' && baseUrl.trim() && !isCanonicalAiBaseUrl(baseUrl.trim())) {
        return NextResponse.json(
          {
            error: 'URL de IA no permitida. El servidor solo acepta los endpoints canónicos de los proveedores soportados.',
            code: 'AI_PROVIDER_RECONFIGURATION_REQUIRED',
          },
          { status: 400 },
        );
      }

      let resolvedBaseUrl: string;
      if (typeof providerId === 'string' && providerId.trim()) {
        try {
          resolvedBaseUrl = resolveProviderBaseUrl(providerId.trim());
        } catch (err) {
          if (err instanceof AiProviderReconfigurationError) {
            return NextResponse.json(
              { error: 'Proveedor de IA no permitido. Seleccioná uno de los proveedores soportados.', code: err.code },
              { status: 400 },
            );
          }
          throw err;
        }
      } else if (typeof baseUrl === 'string' && baseUrl.trim()) {
        resolvedBaseUrl = baseUrl.trim();
      } else {
        resolvedBaseUrl = AI_CONFIG.BASE_URL;
      }

      // Persist to DB — encrypts internally via setAiConfig and clears the cache.
      await setAiConfig({ apiKey, model, baseUrl: resolvedBaseUrl });

      return NextResponse.json({
        success: true,
        providerId: providerIdForCanonicalBaseUrl(resolvedBaseUrl),
      });
    } catch (error) {
      console.error('Error saving AI configuration:', error);
      return NextResponse.json(
        { error: 'Fallo al guardar la configuración' },
        { status: 500 },
      );
    }
  },
  { requireMembership: false },
);
