import { NextRequest, NextResponse } from 'next/server';
import {
  AI_CONFIG,
  AiProviderReconfigurationError,
  isCanonicalAiBaseUrl,
  resolveProviderBaseUrl,
  resolveProviderDefaultModel,
} from '@/lib/constants/ai-config';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { requireGlobalAdminRole } from '@/lib/rbac';
import { safeFetch } from '@/lib/security/safe-fetch';

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
      // An arbitrary baseUrl can never become the network destination.
      if (typeof baseUrl === 'string' && baseUrl.trim() && !isCanonicalAiBaseUrl(baseUrl.trim())) {
        return NextResponse.json(
          {
            error: 'URL de IA no permitida. El servidor solo acepta los endpoints canónicos de los proveedores soportados.',
            code: 'AI_PROVIDER_RECONFIGURATION_REQUIRED',
          },
          { status: 400 },
        );
      }

      let baseUrlToUse: string;
      if (typeof providerId === 'string' && providerId.trim()) {
        try {
          baseUrlToUse = resolveProviderBaseUrl(providerId.trim());
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
        baseUrlToUse = baseUrl.trim();
      } else {
        baseUrlToUse = AI_CONFIG.BASE_URL;
      }

      const modelToVerify =
        model ||
        (typeof providerId === 'string' ? resolveProviderDefaultModel(providerId) : undefined) ||
        AI_CONFIG.DEFAULT_MODEL;

      const res = await safeFetch(`${baseUrlToUse}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
        },
        body: JSON.stringify({
          model: modelToVerify,
          messages: [{ role: 'user', content: 'Responde solo con la palabra OK.' }],
        }),
      });

      if (res.status === 429) {
        return NextResponse.json({
          success: true,
          warning:
            'API Key válida, pero el modelo gratuito está temporalmente saturado (Rate Limit). Podés guardar la configuración.',
          model: modelToVerify,
        });
      }

      if (res.ok) {
        return NextResponse.json({ success: true });
      }

      if (res.status === 401 || res.status === 403) {
        return NextResponse.json({ error: 'API Key inválida o sin permisos.' }, { status: 401 });
      }

      const errorData = await res.json().catch(() => ({}));
      return NextResponse.json(
        { error: errorData.error?.message || 'Clave rechazada por OpenRouter' },
        { status: 400 },
      );
    } catch (error) {
      return NextResponse.json(
        { error: 'No se pudo contactar al servidor de IA' },
        { status: 500 },
      );
    }
  },
  { requireMembership: false },
);
