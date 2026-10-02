import { useQuery } from '@tanstack/react-query';
import type { NavEntitlementRow } from '@/lib/nav-entitlements';

export interface NavEntitlementsResponse {
  companyId: string;
  entitlements: NavEntitlementRow[];
}

export interface UseNavEntitlementsResult {
  rows: NavEntitlementRow[] | null;
  isLoading: boolean;
  error: unknown;
}

export function useNavEntitlements(
  companyId: string | null | undefined,
): UseNavEntitlementsResult {
  const query = useQuery<NavEntitlementsResponse>({
    queryKey: ['module-nav-entitlements', companyId ?? null],
    enabled: Boolean(companyId),
    retry: false,
    queryFn: async () => {
      if (!companyId) {
        throw new Error('companyId is required');
      }
      const response = await fetch(
        `/api/company/entitlements?companyId=${encodeURIComponent(companyId)}`,
        { credentials: 'include' },
      );
      if (!response.ok) {
        throw new Error(`Failed to load module entitlements: ${response.status}`);
      }
      return (await response.json()) as NavEntitlementsResponse;
    },
  });

  const rows =
    query.data && query.data.companyId === companyId ? query.data.entitlements : null;

  return {
    rows,
    isLoading: query.isLoading,
    error: query.error,
  };
}
