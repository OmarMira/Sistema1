import { NextRequest, NextResponse } from 'next/server';
import { AppError, AuthError, ForbiddenError, ValidationError } from './api-error';
import { getSessionUserId } from './sessions';
import { requireActiveTenantAccess } from './rbac';
import { checkRateLimit } from './security/rate-limiter';
import { getClientIp } from './security/client-ip';
import { db } from './db';
import { requestContext } from './context-storage';
import { logger } from './logger';
import { acquireNormalOperation } from './backup-runtime-maintenance';

const API_SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

/**
 * S8 — Prisma error codes that mean "the database is unavailable", not "your data
 * violates a constraint". Mapping these to 400 DATABASE_ERROR told every client
 * their input was wrong and hid a real outage behind a validation error.
 *
 * Connection class: P1000 authentication failed, P1001 cannot reach the server,
 * P1002 the server closed the connection on timeout, P1003 the database does not
 * exist, P1008 operations timed out, P1010 access denied, P1011 TLS error, P1017
 * the server closed the connection, P2024 the connection pool timed out.
 * Constraint/validation codes (P2000-P2034 …) keep answering 400.
 */
const PRISMA_UNAVAILABLE_CODES: ReadonlySet<string> = new Set([
  'P1000',
  'P1001',
  'P1002',
  'P1003',
  'P1008',
  'P1010',
  'P1011',
  'P1017',
  'P2024',
]);

const DATABASE_UNAVAILABLE_MESSAGE =
  'La base de datos no está disponible en este momento. Intentá nuevamente en unos segundos.';

/** Retry-After hint (seconds) for an unavailable-database answer. */
const DATABASE_UNAVAILABLE_RETRY_AFTER = '5';

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
 *
 * SECURITY: the extracted companyId is NOT trusted. Every route that
 * accesses company-scoped data MUST go through requireActiveTenantAccess
 * (or requireCompanyRole), which validates the caller's membership and
 * active status against the supplied companyId. A foreign companyId
 * with a valid session is rejected with 403. The multi-source extraction
 * exists because a user can belong to multiple companies and the active
 * company is a client-side selection — the server enforces authorization,
 * not the source of the id.
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
  const admitted = admittedApiHandler(handler, options);
  return async (request: NextRequest, context: RouteContext) => {
    try {
      // Always acquire a fresh lease: an HTTP request cannot inherit recovery
      // authority or bypass admission through headers, sessions, or options.
      const lease = acquireNormalOperation();
      try { return await lease.run(() => admitted(request, context)); }
      finally { lease.release(); }
    } catch {
      return NextResponse.json(
        { error: 'Maintenance admission unavailable', code: 'BACKUP_MAINTENANCE' },
        { status: 503, headers: API_SECURITY_HEADERS },
      );
    }
  };
}

function admittedApiHandler(handler: ApiHandler, options: ApiHandlerOptions = {}) {
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
      let tenantVerified = false;
      if (requireMembership && userId) {
        if (!companyId) {
          throw new ValidationError('companyId is required');
        }

        await requireActiveTenantAccess(companyId, { userId, role: userRole ?? '' });
        // super_admin bypasses the membership lookup, so its companyId is not
        // proven to exist; only a verified membership makes the pair DB-backed.
        tenantVerified = userRole !== 'super_admin';
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
        // S23e: only a session user id plus an already-verified tenant may be
        // written to the audit trail. An IP bucket or the 'global' placeholder
        // is logged instead (those rows used to violate AuditLog foreign keys).
        const auditSubject =
          userId && companyId && tenantVerified ? { userId, companyId } : null;
        const rl = checkRateLimit(
          rateLimitKey,
          companyId || 'global',
          request.nextUrl.pathname,
          auditSubject,
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
        const prismaCode = (error as { code?: unknown }).code;
        if (typeof prismaCode === 'string' && PRISMA_UNAVAILABLE_CODES.has(prismaCode)) {
          // S8: an outage is a 503 the client can retry, not a 400 that blames input.
          logger.error('[PRISMA DB UNAVAILABLE]', { prismaCode, error: String(error) });
          errResponse = NextResponse.json(
            {
              error: DATABASE_UNAVAILABLE_MESSAGE,
              code: 'DATABASE_UNAVAILABLE',
              retryable: true,
            },
            {
              status: 503,
              headers: { ...API_SECURITY_HEADERS, 'Retry-After': DATABASE_UNAVAILABLE_RETRY_AFTER },
            },
          );
        } else {
          logger.error('[PRISMA DB ERROR]', { error: String(error) });
          errResponse = NextResponse.json(
            { error: 'Error de restricción o de base de datos.', code: 'DATABASE_ERROR' },
            { status: 400 },
          );
        }
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
