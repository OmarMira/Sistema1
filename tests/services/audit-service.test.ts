import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

const mockCreateAuditLogWithRetry = vi.hoisted(() => vi.fn());

vi.mock('@/lib/audit', () => ({
  createAuditLogWithRetry: mockCreateAuditLogWithRetry,
}));

vi.mock('@/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    slowQuery: vi.fn(),
  },
}));

import { safeAuditLog } from '@/lib/services/audit-service';

describe('safeAuditLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const baseData = {
    companyId: 'company-1',
    userId: 'user-1',
    action: 'LOGIN',
    entity: 'User',
    entityId: 'user-1',
    details: { ip: '192.168.1.1', browser: 'Chrome' },
  };

  it('should pass through full data and serialize details to JSON', async () => {
    mockCreateAuditLogWithRetry.mockResolvedValue({ id: 'audit-1' });

    const result = await safeAuditLog(baseData);

    expect(result).toEqual({ id: 'audit-1' });
    expect(mockCreateAuditLogWithRetry).toHaveBeenCalledWith({
      companyId: 'company-1',
      userId: 'user-1',
      action: 'LOGIN',
      entity: 'User',
      entityId: 'user-1',
      details: JSON.stringify({ ip: '192.168.1.1', browser: 'Chrome' }),
    });
  });

  it('should fallback entity to "System" when entity is empty string', async () => {
    mockCreateAuditLogWithRetry.mockResolvedValue({ id: 'audit-2' });

    const result = await safeAuditLog({
      ...baseData,
      entity: '',
    });

    expect(result).toEqual({ id: 'audit-2' });
    expect(mockCreateAuditLogWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'System' }),
    );
  });

  it('should pass null details when details is missing', async () => {
    mockCreateAuditLogWithRetry.mockResolvedValue({ id: 'audit-3' });

    const { details, ...dataWithoutDetails } = baseData;

    const result = await safeAuditLog(dataWithoutDetails);

    expect(result).toEqual({ id: 'audit-3' });
    expect(mockCreateAuditLogWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ details: null }),
    );
  });

  it('should pass null details when details is empty object', async () => {
    mockCreateAuditLogWithRetry.mockResolvedValue({ id: 'audit-4' });

    const result = await safeAuditLog({
      ...baseData,
      details: {},
    });

    expect(result).toEqual({ id: 'audit-4' });
    expect(mockCreateAuditLogWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ details: JSON.stringify({}) }),
    );
  });

  it('should propagate errors from createAuditLogWithRetry', async () => {
    const dbError = new Error('Database connection failed');
    mockCreateAuditLogWithRetry.mockRejectedValue(dbError);

    await expect(safeAuditLog(baseData)).rejects.toThrow('Database connection failed');
  });

  it('should pass entityId as null when entityId is missing', async () => {
    mockCreateAuditLogWithRetry.mockResolvedValue({ id: 'audit-5' });

    const { entityId, ...dataWithoutEntityId } = baseData;

    const result = await safeAuditLog(dataWithoutEntityId);

    expect(result).toEqual({ id: 'audit-5' });
    expect(mockCreateAuditLogWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: null }),
    );
  });
});
