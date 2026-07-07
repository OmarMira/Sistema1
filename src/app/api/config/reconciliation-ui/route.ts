import { NextResponse } from 'next/server';
import { readFileSync } from 'fs';
import { join } from 'path';

export const dynamic = 'force-static';
export const revalidate = 300; // 5 min cache

export async function GET() {
  try {
    const configPath = join(process.cwd(), 'rules/reconciliation-ui.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    return NextResponse.json({ config, version: config.version });
  } catch {
    return NextResponse.json({ error: 'Configuración no disponible' }, { status: 500 });
  }
}
