import { db } from '@/lib/db';
import { RelationshipValues } from '@/internal/company-knowledge';

export const dynamic = 'force-dynamic';

export default async function EditEntityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const entity = await db.companyKnowledge.findUnique({ where: { id } });
  if (!entity) return <div className="p-6">Entity not found</div>;

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">Edit: {entity.canonicalName}</h1>
      <p className="text-sm text-gray-500 mb-4">Current version: {entity.version}</p>
      <form action={`/api/company-knowledge/${id}/propose-update`} method="POST" className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1">Canonical Name</label>
          <input name="canonicalName" defaultValue={entity.canonicalName} className="w-full border rounded p-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Aliases (comma separated)</label>
          <input name="aliases" defaultValue={entity.aliases?.join(', ')} className="w-full border rounded p-2" />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Relationship</label>
          <select name="relationship" defaultValue={entity.relationship || ''} className="w-full border rounded p-2">
            <option value="">None</option>
            {RelationshipValues.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded">Propose Update</button>
      </form>
    </div>
  );
}
