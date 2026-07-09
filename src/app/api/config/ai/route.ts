import { NextRequest, NextResponse } from 'next/server';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { getAiConfig, setAiConfig } from '@/lib/ai-config';
import { AI_CONFIG } from '@/lib/constants/ai-config';
import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

async function requireAdminRole(userId: string): Promise<NextResponse | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { role: true },
  });
  if (!user || !['company_admin', 'super_admin'].includes(user.role)) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }
  return null;
}

export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    const denied = await requireAdminRole(userId);
    if (denied) return denied;

    try {
      const config = await getAiConfig();
      const maskedKey =
        config.apiKey.length > 8
          ? config.apiKey.slice(0, 4) + '...' + config.apiKey.slice(-4)
          : '...';

      logger.info('[AI CONFIG GET]', { model: config.model, baseUrl: config.baseUrl, keyPrefix: config.apiKey.slice(0, 6) });

      let aiAlive = false;
      try {
        const verifyRes = await fetch(`${config.baseUrl}/chat/completions`, {
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

      return NextResponse.json({ isSaved: true, apiKey: maskedKey, model: config.model, baseUrl: config.baseUrl, aiAlive });
    } catch (err) {
      logger.error('[AI CONFIG GET] Failed to load config', { error: err instanceof Error ? err.message : String(err) });
      return NextResponse.json({ isSaved: false });
    }
  },
  { requireMembership: false },
);

export const POST = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();
    const denied = await requireAdminRole(userId);
    if (denied) return denied;

    try {
      const { apiKey, model, baseUrl } = await request.json();
      if (!apiKey) {
        return NextResponse.json({ error: 'La clave no puede estar vacía' }, { status: 400 });
      }

      // Persist to DB — encrypts internally via setAiConfig
      await setAiConfig({ apiKey, model, baseUrl });

      // Also mutate process.env for immediate in-process effect
      process.env.AI_API_KEY = apiKey;
      process.env.AI_MODEL = model || process.env.AI_MODEL;

      return NextResponse.json({ success: true });
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
