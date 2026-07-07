import { NextResponse } from 'next/server';
import { readJsonConfig } from '@/lib/config-loader';
import { logger } from '@/lib/logger';

export async function GET() {
  try {
    const profiles = await readJsonConfig('direction-profiles.json');
    return NextResponse.json({ success: true, data: profiles });
  } catch (err: unknown) {
    logger.error('[DIRECTION PROFILES CONFIG ERROR]', { error: String(err) });
    return NextResponse.json({ error: 'Direction profiles unavailable' }, { status: 500 });
  }
}
