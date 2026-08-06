import { NextRequest } from 'next/server';
import { isIP } from 'node:net';

export type ClientIpSource = 'none' | 'trusted-x-forwarded-for';

function isValidIp(value: string): boolean {
  return isIP(value) !== 0;
}

export function getClientIpSource(): ClientIpSource {
  const v = process.env.CLIENT_IP_SOURCE;
  if (!v) return 'none';
  if (v === 'none' || v === 'trusted-x-forwarded-for') {
    return v;
  }
  throw new Error(`CLIENT_IP_SOURCE=${v} is not supported`);
}

export function getClientIp(request: NextRequest): string | null {
  const source = getClientIpSource();
  switch (source) {
    case 'none':
      return null;
    case 'trusted-x-forwarded-for': {
      // PRECONDICIÓN DE SEGURIDAD CRÍTICA:
      // Solo puede habilitarse cuando el reverse proxy aguas arriba elimina y reescribe
      // completamente el encabezado x-forwarded-for antes de reenviarlo al servidor.
      // De lo contrario, un atacante puede forjar el encabezado de forma trivial.
      const raw = request.headers.get('x-forwarded-for');
      const first = raw?.split(',')[0]?.trim();
      return first && isValidIp(first) ? first : null;
    }
  }
}
