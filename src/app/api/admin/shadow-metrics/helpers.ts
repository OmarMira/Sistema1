import { NextResponse } from 'next/server';

/** @visibleForTesting */
export function parseDateOrError(value: string, label: string): Date | NextResponse {
  const d = new Date(value);
  if (isNaN(d.getTime())) {
    return NextResponse.json(
      { error: `Invalid ${label}: "${value}" is not a valid date`, code: 'VALIDATION_ERROR' },
      { status: 400 },
    );
  }
  return d;
}
