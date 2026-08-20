import { NextRequest, NextResponse } from 'next/server';
import { AppError, AuthError, ForbiddenError, ValidationError } from './api-error';
import { getSessionUserId } from './sessions';
import { requireActiveTenantAccess } from './rbac';
import { checkRateLimit } from './security/rate-limiter';
import { getClientIp } from './security/client-ip';
import { db } from './db';
import { requestContext } from './context-storage';
import { logger } from './logger';

const API_SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export type RouteParams = Record<string, string>;
export type RouteContext = { params: Promise<RouteParams> };
type ApiHandler = (
  request: NextRequest,
  context: RouteContext,
) => Promise<NextResponse> | NextResponse;

export interface ApiHandlerOptions {
  requireMembership?: boolean; // Default: true
  requireSuperAdmin?: boolean; // Default: false
  allowAnonymous?: boolean; // Default: false
}

/**
 * Extrae el companyId desde múltiples fuentes:
 * 1. Query parameters (?companyId=xxx)
 * 2. Cabeceras HTTP (x-company-id)
 * 3. Cuerpo JSON de la petición (POST, PUT, PATCH, DELETE)
 * 4. Datos de formulario Multipart (multipart/form-data)
 */
async function extractCompanyId(request: NextRequest): Promise<string | null> {
  const { searchParams } = new URL(request.url);
  const queryCompanyId = searchParams.get('companyId');
  const headerCompanyId = request.headers.get('x-company-id');

  // URL/Header takes precedence for determining the "declared" company
  const declaredCompanyId = queryCompanyId || headerCompanyId || null;

  let bodyCompanyId: string | null = null;

  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      try {
        const body = await request.clone().json();
        if (body?.companyId && typeof body.companyId === 'string') {
          bodyCompanyId = body.companyId;
        }
      } catch {
        // Ignorar errores
      }
    } else if (contentType.includes('multipart/form-data')) {
      try {
        const formData = await request.clone().formData();
        const cid = formData.get('companyId');
        if (cid && typeof cid === 'string') {
          bodyCompanyId = cid;
        }
      } catch {
        // Ignorar errores
      }
    }
  }

  // Anti-Parameter-Pollution: If both are provided, they MUST match
  if (declaredCompanyId && bodyCompanyId && declaredCompanyId !== bodyCompanyId) {
    throw new ValidationError('Parameter pollution detected: companyId mismatch between URL/Header and Body');
  }

  return declaredCompanyId || bodyCompanyId || null;
}

export function apiHandler(handler: ApiHandler, options: ApiHandlerOptions = {}) {
  const requireMembership = options.requireMembership ?? true;
  const requireSuperAdmin = options.requireSuperAdmin ?? false;
  const allowAnonymous = options.allowAnonymous ?? false;

  return async (request: NextRequest, context: RouteContext) => {
    try {
      // 1. Obtener identificador único (sesión de usuario)
      const userId = await getSessionUserId(request);

      // Validar autenticación si no se permite anónimo
      if (!userId && !allowAnonymous) {
        throw new AuthError('Unauthorized');
      }

      // 2. Extraer companyId
      const companyId: string | undefined = (await extractCompanyId(request)) ?? undefined;

      // 3. Fetch user role una sola vez (para super_admin bypass y requireSuperAdmin)
      let userRole: string | undefined;
      const needsRole = requireSuperAdmin || (requireMembership && !!userId);
      if (needsRole && userId) {
        const user = await db.user.findUnique({
          where: { id: userId },
          select: { platformRole: true },
        });
        userRole = user?.platformRole;
      }

      // 4. Validar Super Admin si se requiere
      if (requireSuperAdmin) {
        if (userRole !== 'super_admin') {
          throw new ForbiddenError('Forbidden');
        }
      }

      // 5. Validar acceso tenant (empresa activa + membresía, con bypass super_admin)
      //    Delegado a requireActiveTenantAccess: única fuente de verdad.
      if (requireMembership && userId) {
        if (!companyId) {
          throw new ValidationError('companyId is required');
        }

        await requireActiveTenantAccess(companyId, { userId, role: userRole ?? '' });
      }

      // 5. Ejecutar validación de rate limit
      // Clave: userId (autenticado) o IP confiable (anónimo tras proxy verificado).
      // DECISIÓN DE SEGURIDAD: cuando clientIp === null y no existe userId, se omite
      // deliberadamente el rate limit genérico para NO crear un bucket global compartido
      // (p.ej. "anonymous"), que un atacante podría agotar para DoS a todos los usuarios.
      const clientIp = getClientIp(request);
      const rateLimitKey = userId || clientIp;
      let rateLimitApplied = false;
      let limit = 0;
      let remaining = 0;
      let resetAt = '';

      if (rateLimitKey !== null) {
        const rl = checkRateLimit(
          rateLimitKey,
          companyId || 'global',
          request.nextUrl.pathname,
        );
        limit = rl.limit;
        remaining = rl.remaining;
        resetAt = rl.resetAt.toString();
        rateLimitApplied = true;
        if (!rl.allowed) {
          return NextResponse.json(
            { error: '429 Too Many Requests', retryAfter: rl.resetAt },
            {
              status: 429,
              headers: {
                'Retry-After': rl.resetAt.toString(),
                'X-RateLimit-Limit': rl.limit.toString(),
                'X-RateLimit-Remaining': '0',
                'X-RateLimit-Reset': rl.resetAt.toString(),
              },
            },
          );
        }
      }

      // 6. Ejecutar el handler en AsyncLocalStorage
      const response = await requestContext.run(
        { userId: userId || 'anonymous', companyId: companyId || '' },
        () => handler(request, context),
      );

      // 7. Inyectar cabeceras de seguridad + rate limit
      if (response && response.headers) {
        Object.entries(API_SECURITY_HEADERS).forEach(([key, value]) => {
          response.headers.set(key, value);
        });
        if (rateLimitApplied) {
          response.headers.set('X-RateLimit-Limit', limit.toString());
          response.headers.set('X-RateLimit-Remaining', remaining.toString());
          response.headers.set('X-RateLimit-Reset', resetAt);
        }
      }

      return response;
    } catch (error: unknown) {
      let errResponse: NextResponse;

      if (error instanceof AppError) {
        errResponse = NextResponse.json(
          {
            error: error.message,
            code: error.code,
            details: error.details,
          },
          { status: error.statusCode },
        );
      } else if (typeof error === 'object' && error !== null && 'statusCode' in error) {
        const appErr = error as {
          message?: string;
          code?: string;
          details?: unknown;
          statusCode: number;
        };
        errResponse = NextResponse.json(
          {
            error: appErr.message || 'Error',
            code: appErr.code,
            ...(process.env.NODE_ENV === 'development' ? { details: appErr.details } : {}),
          },
          { status: appErr.statusCode },
        );
      } else if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        'clientVersion' in error
      ) {
        logger.error('[PRISMA DB ERROR]', { error: String(error) });
        errResponse = NextResponse.json(
          { error: 'Database constraint violation or error occurred.', code: 'DATABASE_ERROR' },
          { status: 400 },
        );
      } else {
        logger.error('[UNHANDLED API ERROR]', { error: String(error) });
        errResponse = NextResponse.json(
          { error: 'Internal server error', code: 'INTERNAL_SERVER_ERROR' },
          { status: 500 },
        );
      }

      Object.entries(API_SECURITY_HEADERS).forEach(([key, value]) => {
        errResponse.headers.set(key, value);
      });
      return errResponse;
    }
  };
}
