import { loadInstalledLogo } from '@/lib/uploads/logo-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ filename: string }> }) {
  try {
    const { filename } = await context.params;
    const image = await loadInstalledLogo(filename);
    if (!image) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(image.bytes), {
      headers: {
        'Content-Type': image.type,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'Cache-Control': 'private, max-age=0, must-revalidate',
      },
    });
  } catch {
    return new Response('Logo temporarily unavailable.', { status: 503 });
  }
}
