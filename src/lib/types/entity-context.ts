import { EntityContext } from '@prisma/client';

export interface EntityContextWithGlAccount extends EntityContext {
  glAccount: {
    id: string;
    code: string;
    name: string;
  } | null;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface UpdateEntityInput {
  role?: string;
  glAccountId?: string | null;
  roles?: string[];
  transactionDirection?: string | null;
}

export interface BulkDeleteInput {
  ids: string[];
}