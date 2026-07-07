import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Checkbox } from '@/components/ui/checkbox';
import { useEffect, useRef, useCallback } from 'react';

interface DualPaneItem {
  id: string;
  amount: number;
  confidenceScore?: number;
  [key: string]: string | number | boolean | undefined;
}

interface DualPaneConfig {
  layout: {
    visibleColumns: string[];
  };
}

interface DualPaneViewProps {
  data: {
    transactions?: { unreconciled: DualPaneItem[] };
    postedJournalEntries?: DualPaneItem[];
  };
  config: DualPaneConfig;
  selectedBankTx: string[];
  setSelectedBankTx: React.Dispatch<React.SetStateAction<string[]>>;
  selectedJournalEntry: string | null;
  setSelectedJournalEntry: (id: string | null) => void;
  splitWidth: string;
}

export function DualPaneView({
  data,
  config,
  selectedBankTx,
  setSelectedBankTx,
  selectedJournalEntry,
  setSelectedJournalEntry,
  splitWidth,
}: DualPaneViewProps) {
  const bankRef = useRef<HTMLDivElement>(null);
  const journalRef = useRef<HTMLDivElement>(null);

  const handleSyncScroll = useCallback((source: 'bank' | 'journal') => {
    const src = source === 'bank' ? bankRef.current : journalRef.current;
    const target = source === 'bank' ? journalRef.current : bankRef.current;
    if (src && target) target.scrollTop = src.scrollTop;
  }, []);

  useEffect(() => {
    const bankEl = bankRef.current;
    const journalEl = journalRef.current;

    const onBankScroll = () => handleSyncScroll('bank');
    const onJournalScroll = () => handleSyncScroll('journal');

    bankEl?.addEventListener('scroll', onBankScroll);
    journalEl?.addEventListener('scroll', onJournalScroll);

    return () => {
      bankEl?.removeEventListener('scroll', onBankScroll);
      journalEl?.removeEventListener('scroll', onJournalScroll);
    };
  }, [handleSyncScroll]);

  const renderList = (items: DualPaneItem[], isBank: boolean) => (
    <div ref={isBank ? bankRef : journalRef} className="overflow-auto max-h-[500px]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">Sel</TableHead>
            {config.layout.visibleColumns.map((col: string) => (
              <TableHead key={col}>{col.toUpperCase()}</TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item: DualPaneItem) => {
            const isSelected = isBank
              ? selectedBankTx.includes(item.id)
              : selectedJournalEntry === item.id;
            const toggleSelect = () =>
              isBank
                ? setSelectedBankTx((prev: string[]) =>
                    prev.includes(item.id)
                      ? prev.filter((i: string) => i !== item.id)
                      : [...prev, item.id],
                  )
                : setSelectedJournalEntry(isSelected ? null : item.id);

            return (
              <TableRow
                key={item.id}
                className={`cursor-pointer hover:bg-muted/50 ${isSelected ? 'bg-primary/10' : ''}`}
                onClick={toggleSelect}
              >
                <TableCell>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={toggleSelect}
                    onClick={(e) => e.stopPropagation()}
                  />
                </TableCell>
                {config.layout.visibleColumns.map((col: string) => (
                  <TableCell key={col} className="font-mono text-xs">
                    {col === 'amount' ? `$${Math.abs(item.amount).toFixed(2)}` : item[col] || '-'}
                  </TableCell>
                ))}
                {item.confidenceScore && (
                  <TableCell className="text-xs text-emerald-600">
                    💡 {Math.round(item.confidenceScore * 100)}%
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );

  return (
    <div className="flex flex-col md:flex-row gap-4">
      <div style={{ width: splitWidth }}>
        <h4 className="text-sm font-semibold mb-2 text-muted-foreground">
          Transacciones Bancarias
        </h4>
        {renderList(data.transactions?.unreconciled || [], true)}
      </div>
      <div style={{ width: '100%' }}>
        <h4 className="text-sm font-semibold mb-2 text-muted-foreground">
          Libro Mayor (Asientos Posteados)
        </h4>
        {renderList(data.postedJournalEntries || [], false)}
      </div>
    </div>
  );
}
