import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function EntityDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ companyId?: string }>;
}) {
  const { id } = await params;
  const { companyId } = await searchParams;

  if (!companyId) {
    return <div className="p-6">Company context required</div>;
  }

  const entity = await db.companyKnowledge.findFirst({
    where: { id, companyId },
  });

  if (!entity) return <div className="p-6">Entity not found</div>;

  const audits = await db.knowledgeAudit.findMany({
    where: { knowledgeId: id },
    orderBy: { timestamp: 'asc' },
  });

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-2xl font-bold mb-4">{entity.canonicalName}</h1>
      <dl className="space-y-2 mb-6">
        <dt className="font-medium">Type</dt><dd>{entity.type}</dd>
        <dt className="font-medium">Relationship</dt><dd>{entity.relationship || '-'}</dd>
        <dt className="font-medium">Status</dt><dd>{entity.status}</dd>
        <dt className="font-medium">Version</dt><dd>{entity.version}</dd>
        <dt className="font-medium">Aliases</dt><dd>{entity.aliases?.join(', ') || '-'}</dd>
      </dl>
      <div className="flex gap-2 mb-6">
        <a href={`/company-knowledge/${id}/edit`} className="px-3 py-1 bg-green-600 text-white rounded">Edit</a>
      </div>
      <h2 className="text-xl font-bold mb-2">Audit Trail</h2>
      <table className="w-full border-collapse border">
        <thead><tr className="bg-gray-100">
          <th className="border p-2">Action</th><th className="border p-2">Version</th><th className="border p-2">User</th><th className="border p-2">Date</th><th className="border p-2">Reason</th>
        </tr></thead>
        <tbody>
          {audits.map(a => (
            <tr key={a.id}>
              <td className="border p-2">{a.action}</td>
              <td className="border p-2">{a.version}</td>
              <td className="border p-2">{a.changedByUserId}</td>
              <td className="border p-2">{a.timestamp.toISOString()}</td>
              <td className="border p-2">{a.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
