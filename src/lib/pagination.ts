import { NextResponse } from 'next/server';

export interface PaginationParams {
  page: number;
  limit: number;
}

export function parsePaginationParams(
  searchParams: URLSearchParams,
  defaultLimit = 20,
  maxLimit = 100,
): PaginationParams {
  const page = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(searchParams.get('limit') ?? String(defaultLimit), 10) || defaultLimit));
  return { page, limit };
}

export function offsetPaginatedResponse<T>(
  data: T[],
  total: number,
  page: number,
  limit: number,
) {
  return NextResponse.json({
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
}

export interface CursorResult<T> {
  data: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export function cursorPaginatedResponse<T>(items: T[], limit: number): CursorResult<T> {
  const hasMore = items.length > limit;
  if (hasMore) {
    items.pop();
  }
  return {
    data: items,
    nextCursor: hasMore ? items[items.length - 1]!['id' as keyof T] as string : null,
    hasMore,
  };
}
