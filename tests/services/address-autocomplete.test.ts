import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
global.fetch = mockFetch as any;

import { fetchAddressSuggestions, type AddressData } from '@/lib/services/address-autocomplete';

describe('fetchAddressSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty array for null/undefined query', async () => {
    const result = await fetchAddressSuggestions(null as unknown as string);
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return empty array for query shorter than 3 characters', async () => {
    const result = await fetchAddressSuggestions('ab');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return empty array for exactly 2 character query', async () => {
    const result = await fetchAddressSuggestions('av');
    expect(result).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should fetch suggestions and return results for valid query', async () => {
    const mockAddresses: AddressData[] = [
      {
        fullAddress: 'Av Corrientes 1234, CABA',
        streetLine1: 'Av Corrientes 1234',
        streetLine2: '',
        city: 'Buenos Aires',
        state: 'CABA',
        zipCode: '1043',
      },
      {
        fullAddress: 'Av Corrientes 5678, CABA',
        streetLine1: 'Av Corrientes 5678',
        streetLine2: '',
        city: 'Buenos Aires',
        state: 'CABA',
        zipCode: '1045',
      },
    ];

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: mockAddresses }),
    });

    const result = await fetchAddressSuggestions('Av Corrientes');

    expect(mockFetch).toHaveBeenCalledWith(
      '/api/address/autocomplete?q=Av%20Corrientes',
    );
    expect(result).toEqual(mockAddresses);
    expect(result).toHaveLength(2);
  });

  it('should encode the query parameter', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ results: [] }),
    });

    await fetchAddressSuggestions('calle 123 & más');
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/address/autocomplete?q=calle%20123%20%26%20m%C3%A1s',
    );
  });

  it('should return empty array when results field is missing', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const result = await fetchAddressSuggestions('Av Corrientes');
    expect(result).toEqual([]);
  });

  it('should throw on non-ok response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    await expect(
      fetchAddressSuggestions('Av Corrientes'),
    ).rejects.toThrow('Fallo al obtener sugerencias de dirección');
  });

  it('should throw on network error', async () => {
    mockFetch.mockRejectedValue(new Error('Network failure'));

    await expect(
      fetchAddressSuggestions('Av Corrientes'),
    ).rejects.toThrow('Network failure');
  });
});
