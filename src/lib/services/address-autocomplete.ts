export interface AddressData {
  fullAddress: string;
  streetLine1: string;
  streetLine2: string;
  city: string;
  state: string;
  zipCode: string;
  isManual?: boolean;
}

export async function fetchAddressSuggestions(query: string): Promise<AddressData[]> {
  if (!query || query.length < 3) return [];

  const res = await fetch(`/api/address/autocomplete?q=${encodeURIComponent(query)}`);
  if (!res.ok) {
    throw new Error('Fallo al obtener sugerencias de dirección');
  }

  const data = await res.json();
  return data.results || [];
}
