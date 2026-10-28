import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

export function JournalCorrectionButton({ entryId, onCorrected }: { entryId: string; onCorrected?: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [correctedAmount, setCorrectedAmount] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit() {
    setLoading(true);
    try {
      await fetch(`/api/journal/${entryId}/corregir`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ correctedLines: [], reason }), // placeholder for full line mapping
      });
      setOpen(false);
      onCorrected?.();
    } finally { setLoading(false); }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Corregir operación</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Corregir operación</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm">El asiento original se conserva. El sistema generará el contraasiento y el reemplazo.</p>
            <Textarea placeholder="Motivo de la corrección (ej: importe incorrecto)" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
          <DialogFooter>
            <Button onClick={handleSubmit} disabled={loading}>Confirmar corrección</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
