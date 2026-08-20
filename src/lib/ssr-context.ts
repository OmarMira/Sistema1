import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import { getSessionCookieName, getSessionUserIdFromToken } from '@/lib/sessions';
import { requireActiveTenantAccess } from '@/lib/rbac';

export type SsrCompanyContext =
  | { ok: true; userId: string; companyId: string }
  | { ok: false; reason: 'unauthenticated' | 'missing-company' | 'forbidden' };

/**
 * Gate SSR para lectura de companyKnowledge.
 *
 * Contrato de seguridad (G3 / aislamiento SSR):
 * 1. Autentica al usuario por sesión (cookie __Host-session / session).
 * 2. El companyId recibido (searchParams) es SOLO un candidato, nunca autoridad.
 * 3. Valida membresía física con requireActiveTenantAccess (super_admin bypass,
 *    Company.isActive, CompanyMember).
 * 4. Devuelve el companyId autorizado; ninguna query de la página debe ejecutarse
 *    salvo con este valor.
 *
 * NO lanza errores HTTP: en Server Components no existe un contrato 403 establecido
 * en el proyecto (sin error.tsx). Devuelve un resultado discriminado y la página
 * renderiza un estado neutro fail-closed (cero consultas companyKnowledge).
 */
export async function requireSsrCompanyContext(
  companyIdCandidate?: string,
): Promise<SsrCompanyContext> {
  const cookieStore = await cookies();
  const rawToken =
    cookieStore.get(getSessionCookieName())?.value ??
    cookieStore.get('__Host-session')?.value ??
    cookieStore.get('session')?.value ??
    null;

  const userId = await getSessionUserIdFromToken(rawToken);
  if (!userId) return { ok: false, reason: 'unauthenticated' };

  const companyId = companyIdCandidate?.trim();
  if (!companyId) return { ok: false, reason: 'missing-company' };

  const user = await db.user.findUnique({
    where: { id: userId },
    select: { platformRole: true },
  });

  try {
    await requireActiveTenantAccess(companyId, { userId, role: user?.platformRole ?? '' });
  } catch {
    return { ok: false, reason: 'forbidden' };
  }

  return { ok: true, userId, companyId };
}