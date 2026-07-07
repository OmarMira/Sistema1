'use client';

import { useCallback, useState } from 'react';
import { EntityTypeValues, RelationshipValues } from '@/internal/company-knowledge';

export default function NewEntityPage() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const handleSubmit = useCallback(async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setStatus('loading');
    setErrorMsg('');

    const form = new FormData(e.currentTarget);
    const aliasesRaw = (form.get('aliases') as string) || '';
    const body = {
      type: form.get('type'),
      canonicalName: form.get('canonicalName'),
      aliases: aliasesRaw ? aliasesRaw.split(',').map(a => a.trim()).filter(Boolean) : [],
      relationship: form.get('relationship') || undefined,
    };

    const res = await fetch('/api/company-knowledge/propose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      setErrorMsg(data.error || 'Error creating proposal');
      setStatus('error');
      return;
    }

    setStatus('success');
  }, []);

  if (status === 'success') {
    return (
      <div className="p-6 max-w-2xl">
        <h1 className="text-2xl font-bold mb-4">Proposal Created</h1>
        <p className="text-green-600">Your entity proposal has been submitted for approval.</p>
        <a href="/company-knowledge" className="mt-4 inline-block text-blue-600 underline">Back to entities</a>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">New Entity</h1>
      {status === 'error' && <p className="text-red-600 mb-4">{errorMsg}</p>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Type</label>
          <select name="type" className="w-full border rounded p-2">
            {EntityTypeValues.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Canonical Name</label>
          <input name="canonicalName" className="w-full border rounded p-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Aliases (comma separated)</label>
          <input name="aliases" className="w-full border rounded p-2" placeholder="alias1, alias2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Relationship</label>
          <select name="relationship" className="w-full border rounded p-2">
            <option value="">None</option>
            {RelationshipValues.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <button type="submit" disabled={status === 'loading'} className="px-4 py-2 bg-blue-600 text-white rounded disabled:opacity-50">
          {status === 'loading' ? 'Sending...' : 'Propose'}
        </button>
      </form>
    </div>
  );
}
