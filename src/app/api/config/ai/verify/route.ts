import { NextRequest, NextResponse } from 'next/server';
import { AI_CONFIG } from '@/lib/constants/ai-config';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';

export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();

    try {
      const { apiKey, model, baseUrl } = await request.json();
      if (!apiKey) {
        return NextResponse.json({ error: 'La clave no puede estar vacía' }, { status: 400 });
      }

      const modelToVerify = model || AI_CONFIG.DEFAULT_MODEL;
      const baseUrlToUse = baseUrl || AI_CONFIG.BASE_URL;

      const res = await fetch(`${baseUrlToUse}/chat/completions`, {
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
