import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function CompanyKnowledgePage() {
  const entities = await db.companyKnowledge.findMany({ take: 50, orderBy: { createdAt: 'desc' } });
  return (
    <div className="p-6">
      <h1 className="text-2xl font-bold mb-4">Company Knowledge</h1>
      <a href="/company-knowledge/new" className="inline-block mb-4 px-4 py-2 bg-blue-600 text-white rounded">New Entity</a>
      <table className="w-full border-collapse border">
        <thead><tr className="bg-gray-100">
          <th className="border p-2 text-left">Name</th><th className="border p-2 text-left">Type</th><th className="border p-2 text-left">Relationship</th><th className="border p-2 text-left">Status</th><th className="border p-2 text-left">Version</th><th className="border p-2">Actions</th>
        </tr></thead>
        <tbody>
          {entities.map((e) => (
            <tr key={e.id} className="hover:bg-gray-50">
              <td className="border p-2">{e.canonicalName}</td>
              <td className="border p-2">{e.type}</td>
              <td className="border p-2">{e.relationship || '-'}</td>
              <td className="border p-2">{e.status}</td>
              <td className="border p-2">{e.version}</td>
              <td className="border p-2 text-center">
                <a href={`/company-knowledge/${e.id}`} className="text-blue-600 mr-2">View</a>
                <a href={`/company-knowledge/${e.id}/edit`} className="text-green-600">Edit</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
