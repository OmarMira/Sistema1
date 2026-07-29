import type { ExecutionContract } from './types';

export interface DriverResult {
  readonly success: boolean;
  readonly error?: string;
  readonly detail?: string;
}

export interface Driver {
  execute(contract: ExecutionContract): DriverResult;
}

export function execute(
  contract: ExecutionContract,
  driver: Driver,
): DriverResult {
  try {
    return driver.execute(contract);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown driver error',
    };
  }
}