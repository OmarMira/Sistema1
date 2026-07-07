import { NextRequest, NextResponse } from 'next/server';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { apiHandler, type RouteContext } from '@/lib/api-handler';
import { requireCurrentUserId } from '@/lib/context-storage';
import { logger } from '@/lib/logger';

interface AddressConfig {
  version: string;
  provider: string;
  baseUrl: string;
  userAgent: string;
  debounceMs: number;
  cacheTtlMs: number;
  maxResults: number;
  usOnly: boolean;
}

let config: AddressConfig = {
  version: '1.0',
  provider: 'nominatim',
  baseUrl: 'https://nominatim.openstreetmap.org/search',
  userAgent: 'AccountExpress-AddressService/1.0 (Contact: postmaster@account-express-new-gen.com)',
  debounceMs: 300,
  cacheTtlMs: 300000,
  maxResults: 5,
  usOnly: true,
};

try {
  const configPath = join(process.cwd(), 'rules/address-autocomplete.json');
  if (existsSync(configPath)) {
    config = JSON.parse(readFileSync(configPath, 'utf-8')) as AddressConfig;
  }
} catch (err) {
  logger.warn('[ADDRESS] Config load failed, using defaults', { error: String(err) });
}

interface AddressData {
  fullAddress: string;
  streetLine1: string;
  streetLine2: string;
  city: string;
  state: string;
  zipCode: string;
}

interface NominatimResult {
  display_name: string;
  address: {
    road?: string;
    house_number?: string;
    city?: string;
    town?: string;
    village?: string;
    municipality?: string;
    suburb?: string;
    hamlet?: string;
    county?: string;
    state?: string;
    postcode?: string;
  };
}

const cache = new Map<string, { data: AddressData[]; expiresAt: number }>();

export const GET = apiHandler(
  async (request: NextRequest, context: RouteContext) => {
    const userId = requireCurrentUserId();

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q');

    if (!query || query.length < 3) {
      return NextResponse.json({ results: [] });
    }

    // Clean up expired cache
    const now = Date.now();
    for (const [key, val] of cache.entries()) {
      if (val.expiresAt < now) cache.delete(key);
    }

    const cached = cache.get(query);
    if (cached && cached.expiresAt > now) {
      return NextResponse.json({ results: cached.data });
    }

    const params = new URLSearchParams({
      q: query,
      format: 'json',
      limit: String(config.maxResults),
      addressdetails: '1',
      countrycodes: config.usOnly ? 'us' : '',
    });

    const res = await fetch(`${config.baseUrl}?${params}`, {
      headers: { 'User-Agent': config.userAgent },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: 'Fallo al consultar el servicio de geocodificación.' },
        { status: 502 },
      );
    }

    const results: NominatimResult[] = await res.json();

    // Map US state names to 2-letter codes for compatibility
    const stateMapping: Record<string, string> = {
      alabama: 'AL',
      alaska: 'AK',
      arizona: 'AZ',
      arkansas: 'AR',
      california: 'CA',
      colorado: 'CO',
      connecticut: 'CT',
      delaware: 'DE',
      florida: 'FL',
      georgia: 'GA',
      hawaii: 'HI',
      idaho: 'ID',
      illinois: 'IL',
      indiana: 'IN',
      iowa: 'IA',
      kansas: 'KS',
      kentucky: 'KY',
      louisiana: 'LA',
      maine: 'ME',
      maryland: 'MD',
      massachusetts: 'MA',
      michigan: 'MI',
      minnesota: 'MN',
      mississippi: 'MS',
      missouri: 'MO',
      montana: 'MT',
      nebraska: 'NE',
      nevada: 'NV',
      'new hampshire': 'NH',
      'new jersey': 'NJ',
      'new mexico': 'NM',
      'new york': 'NY',
      'north carolina': 'NC',
      'north dakota': 'ND',
      ohio: 'OH',
      oklahoma: 'OK',
      oregon: 'OR',
      pennsylvania: 'PA',
      'rhode island': 'RI',
      'south carolina': 'SC',
      'south dakota': 'SD',
      tennessee: 'TN',
      texas: 'TX',
      utah: 'UT',
      vermont: 'VT',
      virginia: 'VA',
      washington: 'WA',
      'west virginia': 'WV',
      wisconsin: 'WI',
      wyoming: 'WY',
    };

    // Extract typed house number from query as a fallback to prevent losing it
    const queryNumMatch = query.match(/^(\d+[-/a-zA-Z]?)\s+/);
    const queryHouseNumber = queryNumMatch ? queryNumMatch[1] : '';

    const normalized: AddressData[] = results.map((r) => {
      const road = r.address.road || '';
      const houseNumber = r.address.house_number || '';
      const finalHouseNumber = houseNumber || queryHouseNumber;
      const street = [finalHouseNumber, road].filter(Boolean).join(' ');
      const streetLine1 = street || r.display_name.split(',')[0] || '';

      const stateRaw = r.address.state || '';
      const stateMapped = stateMapping[stateRaw.toLowerCase()] || stateRaw.toUpperCase();
      const stateCode = stateMapped.length === 2 ? stateMapped : stateMapped.substring(0, 2);

      return {
        fullAddress: r.display_name,
        streetLine1,
        streetLine2: '',
        city:
          r.address.city ||
          r.address.town ||
          r.address.village ||
          r.address.municipality ||
          r.address.suburb ||
          r.address.hamlet ||
          r.address.county ||
          '',
        state: stateCode,
        zipCode: r.address.postcode || '',
      };
    });

    cache.set(query, { data: normalized, expiresAt: now + config.cacheTtlMs });
    return NextResponse.json({ results: normalized });
  },
  { requireMembership: false },
);
