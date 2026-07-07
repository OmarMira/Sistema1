'use client';

import { Search, Filter, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useLanguageStore } from '@/store/language-store';

interface JournalFiltersProps {
  searchQuery: string;
  onSearchChange: (val: string) => void;
  statusFilter: string;
  onStatusChange: (val: string) => void;
  startDate: string;
  onStartDateChange: (val: string) => void;
  endDate: string;
  onEndDateChange: (val: string) => void;
  onClearFilters: () => void;
}

export function JournalFilters({
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
  onClearFilters,
}: JournalFiltersProps) {
  const t = useLanguageStore((s) => s.t);
  const hasActiveFilters = statusFilter !== 'all' || !!startDate || !!endDate;

  return (
    <div className="flex flex-col sm:flex-row gap-2">
      <div className="relative flex-1 max-w-sm">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
        <Input
          placeholder={`${t('common.search')}...`}
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="pl-8 h-9"
        />
      </div>

      <Select value={statusFilter} onValueChange={onStatusChange}>
        <SelectTrigger className="w-[140px] h-9">
          <Filter className="size-3.5 mr-1 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{t('common.all')}</SelectItem>
          <SelectItem value="draft">{t('journal.draft')}</SelectItem>
          <SelectItem value="posted">{t('journal.posted')}</SelectItem>
          <SelectItem value="void">{t('journal.void')}</SelectItem>
        </SelectContent>
      </Select>

      <Input
        type="date"
        value={startDate}
        onChange={(e) => onStartDateChange(e.target.value)}
        className="w-[150px] h-9"
      />
      <Input
        type="date"
        value={endDate}
        onChange={(e) => onEndDateChange(e.target.value)}
        className="w-[150px] h-9"
      />
      {hasActiveFilters && (
        <Button variant="ghost" size="sm" onClick={onClearFilters} className="h-9">
          <X className="size-3.5 mr-1" />
          Clear
        </Button>
      )}
    </div>
  );
}
