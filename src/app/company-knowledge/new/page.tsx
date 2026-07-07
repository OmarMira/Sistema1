import { EntityTypeValues, RelationshipValues } from '@/internal/company-knowledge';

export const dynamic = 'force-dynamic';

export default function NewEntityPage() {
  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">New Entity</h1>
      <form action="/api/company-knowledge/propose" method="POST" className="space-y-4">
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
        <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded">Propose</button>
      </form>
    </div>
  );
}
