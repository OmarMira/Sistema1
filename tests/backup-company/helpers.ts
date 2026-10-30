import { Prisma } from '@prisma/client';

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;

// Small read-only relational adapter: queries must actually enforce tenant and
// endpoint filters. This proves adapter behavior, not PostgreSQL isolation.
const relations: Record<string, Record<string, [string, string]>> = {
  bankTransaction: { statement: ['bankStatement', 'statementId'] },
  journalLine: { entry: ['journalEntry', 'entryId'] },
  knowledgeAudit: { companyKnowledge: ['companyKnowledge', 'knowledgeId'] },
  memoryVersion: { item: ['memoryItem', 'itemId'] },
  traceabilityLog: { item: ['memoryItem', 'itemId'] },
  confidenceLog: { item: ['memoryItem', 'itemId'] },
  relationship: { source: ['memoryItem', 'sourceId'], target: ['memoryItem', 'targetId'] },
  contradiction: { itemA: ['memoryItem', 'itemAId'], itemB: ['memoryItem', 'itemBId'] },
  evolutionLink: { superseded: ['memoryItem', 'supersededId'], supersedingBy: ['memoryItem', 'supersededById'] },
};

/** Explicit SQL-null adapter for synthetic fixtures, never a production fallback. */
export function queryNullMetadata(
  tables: Tables,
  query: { strings: readonly string[]; values: readonly unknown[] },
  sqlNulls: Record<string, boolean> = {},
) {
  const sql = query.strings.join('?');
  const model = Prisma.dmmf.datamodel.models.find(m => sql.includes(`FROM "${m.name}"`));
  if (!model) throw new Error('Unknown metadata SQL in fixture');
  const key = model.fields.find(f => f.isId)!.name;
  return (tables[model.name[0].toLowerCase() + model.name.slice(1)] ?? [])
    .filter(row => query.values.includes(row[key]))
    .map(row => ({ [key]: row[key], ...Object.fromEntries(model.fields
      .filter(f => f.type === 'Json' && !f.isRequired)
      .map(f => [f.name, sqlNulls[`${model.name}:${row[key]}:${f.name}`] ?? row[f.name] === null])) }));
}

export function fixtureNullReferences(data: Record<string, Row[]>, models: Record<string, string>) {
  return Object.entries(models).flatMap(([section, name]) => {
    const model = Prisma.dmmf.datamodel.models.find(m => m.name === name)!;
    const key = model.fields.find(f => f.isId)!.name;
    return (data[section] ?? []).flatMap(row => model.fields.filter(f => f.type === 'Json' && !f.isRequired && row[f.name] === null)
      .map(f => ({ model: name, key: { [key]: row[key] }, field: f.name, kind: 'db-null' })));
  });
}

export function queryRows(tables: Tables, model: string, query: any = {}): Row[] {
  function matches(table: string, row: Row, where: Row): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return value.some((branch: Row) => matches(table, row, branch));
      const relation = relations[table]?.[key];
      if (relation) {
        const [target, foreignKey] = relation;
        const parent = tables[target]?.find(candidate => candidate.id === row[foreignKey]);
        return Boolean(parent && matches(target, parent, value));
      }
      if (value && typeof value === 'object' && 'in' in value) return value.in.includes(row[key]);
      return row[key] === value;
    });
  }
  return structuredClone((tables[model] ?? [])
    .filter(row => matches(model, row, query.where ?? {}))
    .map(row => query.select
      ? Object.fromEntries(Object.entries(row).filter(([key]) => query.select[key] === true))
      : row));
}
