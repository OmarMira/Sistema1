'use client';

import { useState, useEffect } from 'react';
import { useAddressAutocomplete } from '@/hooks/useAddressAutocomplete';
import { Input } from '@/components/ui/input';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger, PopoverAnchor } from '@/components/ui/popover';
import { MapPin, Loader2, X } from 'lucide-react';
import { type AddressData } from '@/lib/services/address-autocomplete';

interface AddressAutocompleteProps {
  onSelect: (addr: AddressData) => void;
  defaultValue?: string;
  placeholder?: string;
  id?: string;
  'aria-invalid'?: boolean;
}

export function AddressAutocomplete({
  onSelect,
  defaultValue = '',
  placeholder = 'Buscar dirección en EE.UU...',
  id,
  'aria-invalid': ariaInvalid,
}: AddressAutocompleteProps) {
  const {
    query,
    suggestions,
    loading,
    error,
    handleQueryChange,
    selectSuggestion,
    clear,
    setQuery,
  } = useAddressAutocomplete();
  const [open, setOpen] = useState(false);

  // Sync with default values when initial settings are fetched
  useEffect(() => {
    if (defaultValue && defaultValue !== query) {
      setQuery(defaultValue);
    }
  }, [defaultValue, query, setQuery]);

  return (
    <Popover open={open && (loading || suggestions.length > 0 || !!error)} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative w-full">
          <Input
            id={id}
            aria-invalid={ariaInvalid}
            value={query}
            onChange={(e) => {
              const val = e.target.value;
              handleQueryChange(val);
              setOpen(true);
              // Safe manual fallback sync: propagates typed street to parent state without overwriting other fields
              onSelect({
                fullAddress: val,
                streetLine1: val,
                streetLine2: '',
                city: '',
                state: '',
                zipCode: '',
                isManual: true,
              });
            }}
            placeholder={placeholder}
            className="pr-10 h-10 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            autoComplete="off"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                clear();
                onSelect({
                  fullAddress: '',
                  streetLine1: '',
                  streetLine2: '',
                  city: '',
                  state: '',
                  zipCode: '',
                  isManual: false,
                });
                setOpen(false);
              }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground hover:bg-muted/50 p-1 rounded-md transition-all"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </PopoverAnchor>
      <PopoverContent
        className="w-[300px] sm:w-[480px] p-0"
        align="start"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <Command className="w-full">
          <CommandList className="max-h-[220px] overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin text-primary" />
                <span>Buscando sugerencias...</span>
              </div>
            ) : error ? (
              <div className="py-6 text-center text-sm text-muted-foreground">{error}</div>
            ) : (
              <CommandGroup>
                {suggestions.map((addr, i) => (
                  <CommandItem
                    key={i}
                    value={addr.fullAddress}
                    onSelect={() => {
                      onSelect({
                        ...selectSuggestion(addr),
                        isManual: false,
                      });
                      setOpen(false);
                    }}
                    className="cursor-pointer flex items-start gap-2.5 p-2.5 hover:bg-accent/40 rounded-md"
                  >
                    <MapPin className="size-4 text-primary shrink-0 mt-0.5" />
                    <div className="flex flex-col text-left">
                      <span className="font-semibold text-xs text-foreground leading-tight">
                        {addr.streetLine1}
                      </span>
                      <span className="text-[10px] text-muted-foreground mt-0.5 leading-snug">
                        {[addr.city, addr.state, addr.zipCode].filter(Boolean).join(', ')}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
