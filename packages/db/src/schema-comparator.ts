import type { Pool } from 'pg';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DECLARED_TABLES } from './schema';
import { EXPECTED_SCHEMA_SNAPSHOT } from './schema-snapshot';
import { compareDeclarationToSnapshot } from './schema-projection';
import type { SchemaDifference } from './schema-difference';

/**
 * The exact schema comparator.
 *
 * One implementation, used by the blocking migration gate *and* by the mutation
 * tests that prove it rejects drift. Two separate implementations would let the
 * gate and its own proof disagree, which is the failure mode this replaces.
 *
 * Comparing two `pg_dump` outputs is necessary but not sufficient: the fresh and
 * upgrade paths run the same SQL, so a defect present in both compares equal.
 * This compares the live database against a *declaration* instead — Drizzle for
 * what its DSL expresses, an explicit canonical snapshot for the SQL-only
 * properties — so a schema that is uniformly wrong is still wrong.
 *
 * The two declarations are also compared to each other. Without that, `schema.ts`
 * was consulted only for its table names, and an edit to a declared column or key
 * passed silently while the snapshot still agreed with the database.
 */

export type { SchemaDifference };

/** The kernel schemas the comparator governs. */
export const COMPARED_SCHEMAS = ['platform', 'audit', 'police_audit'] as const;

interface LiveColumn {
  table: string;
  column: string;
  type: string;
  not_null: boolean;
  default_expr: string;
  identity: string;
  generated: string;
}

interface LiveConstraint {
  table: string;
  name: string;
  kind: string;
  definition: string;
}

interface LiveIndex {
  table: string;
  name: string;
  definition: string;
}

/** Every root (non-partition) table the declaration says must exist. */
export function declaredTableNames(): string[] {
  return DECLARED_TABLES.map((table) => {
    const config = getTableConfig(table);
    return `${config.schema ?? 'public'}.${config.name}`;
  }).sort();
}

/**
 * Compares `pool`'s live schema against the declaration.
 *
 * Returns every difference rather than throwing on the first: a caller that
 * needs to fail wants to report all of them, and a mutation test wants to assert
 * on the specific one it introduced.
 */
export async function compareSchema(pool: Pool): Promise<SchemaDifference[]> {
  // Declaration against declaration first: it needs no database, and a
  // disagreement here means the two halves of the contract have drifted apart
  // whatever the live schema happens to hold.
  const differences: SchemaDifference[] = [...compareDeclarationToSnapshot()];
  const schemas = [...COMPARED_SCHEMAS];

  // ---------------------------------------------------------------- tables
  const liveTables = (
    await pool.query<{ table: string }>(
      `SELECT n.nspname || '.' || c.relname AS table
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
        ORDER BY 1`,
      [schemas],
    )
  ).rows.map((row) => row.table);

  const declaredTables = declaredTableNames();
  for (const table of declaredTables) {
    if (!liveTables.includes(table)) {
      differences.push({ kind: 'table', subject: table, expected: 'present', actual: 'missing' });
    }
  }
  for (const table of liveTables) {
    if (!declaredTables.includes(table)) {
      differences.push({
        kind: 'table',
        subject: table,
        expected: 'undeclared',
        actual: 'present',
      });
    }
  }

  // --------------------------------------------------------------- columns
  const liveColumns = (
    await pool.query<LiveColumn>(
      `SELECT n.nspname || '.' || c.relname AS table, a.attname AS column,
              format_type(a.atttypid, a.atttypmod) AS type,
              a.attnotnull AS not_null,
              coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS default_expr,
              a.attidentity::text AS identity,
              a.attgenerated::text AS generated
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
          AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY 1, 2`,
      [schemas],
    )
  ).rows;

  const liveColumnKey = (row: { table: string; column: string }): string =>
    `${row.table}.${row.column}`;
  const liveColumnMap = new Map(liveColumns.map((row) => [liveColumnKey(row), row]));

  for (const expected of EXPECTED_SCHEMA_SNAPSHOT.columns) {
    const actual = liveColumnMap.get(`${expected.table}.${expected.column}`);
    const subject = `${expected.table}.${expected.column}`;
    if (actual === undefined) {
      differences.push({ kind: 'column', subject, expected: 'present', actual: 'missing' });
      continue;
    }
    const actualShape = [
      actual.type,
      actual.not_null ? 'NOT NULL' : 'NULL',
      actual.default_expr === '' ? 'no default' : `default ${actual.default_expr}`,
      actual.identity === '' ? 'no identity' : `identity ${actual.identity}`,
      actual.generated === '' ? 'not generated' : `generated ${actual.generated}`,
    ].join(' | ');
    if (actualShape !== expected.shape) {
      differences.push({ kind: 'column', subject, expected: expected.shape, actual: actualShape });
    }
  }
  for (const actual of liveColumns) {
    const subject = liveColumnKey(actual);
    if (!EXPECTED_SCHEMA_SNAPSHOT.columns.some((c) => `${c.table}.${c.column}` === subject)) {
      differences.push({ kind: 'column', subject, expected: 'undeclared', actual: 'present' });
    }
  }

  // ----------------------------------------------------------- constraints
  const liveConstraints = (
    await pool.query<LiveConstraint>(
      `SELECT n.nspname || '.' || rel.relname AS table, con.conname AS name,
              con.contype::text AS kind, pg_get_constraintdef(con.oid) AS definition
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE n.nspname = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = rel.oid)
        ORDER BY 1, 2`,
      [schemas],
    )
  ).rows;

  compareSets(
    differences,
    'constraint',
    EXPECTED_SCHEMA_SNAPSHOT.constraints.map((c) => ({
      key: `${c.table}.${c.name}`,
      value: `${c.kind} ${c.definition}`,
    })),
    liveConstraints.map((c) => ({
      key: `${c.table}.${c.name}`,
      value: `${c.kind} ${c.definition}`,
    })),
  );

  // --------------------------------------------------------------- indexes
  // Partition children are excluded through `pg_inherits`, the catalogue's own
  // record of the relationship. Excluding them by a `%_20%` name pattern was a
  // guess about how partitions happen to be named: it silently stopped covering
  // them the moment the naming changed, and it also hid any ordinary table whose
  // name matched.
  const liveIndexes = (
    await pool.query<LiveIndex>(
      `SELECT n.nspname || '.' || t.relname AS table, i.relname AS name,
              pg_get_indexdef(ix.indexrelid) AS definition
         FROM pg_index ix
         JOIN pg_class i ON i.oid = ix.indexrelid
         JOIN pg_class t ON t.oid = ix.indrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = ANY($1)
          AND NOT EXISTS (SELECT 1 FROM pg_inherits inh WHERE inh.inhrelid = t.oid)
        ORDER BY 1, 2`,
      [schemas],
    )
  ).rows;

  compareSets(
    differences,
    'index',
    EXPECTED_SCHEMA_SNAPSHOT.indexes.map((i) => ({
      key: `${i.table}.${i.name}`,
      value: i.definition,
    })),
    liveIndexes.map((i) => ({ key: `${i.table}.${i.name}`, value: i.definition })),
  );

  return differences;
}

/** Compares two keyed sets, recording missing, extra and differing entries. */
function compareSets(
  into: SchemaDifference[],
  kind: string,
  expected: readonly { key: string; value: string }[],
  actual: readonly { key: string; value: string }[],
): void {
  const actualMap = new Map(actual.map((entry) => [entry.key, entry.value]));
  const expectedMap = new Map(expected.map((entry) => [entry.key, entry.value]));

  for (const entry of expected) {
    const found = actualMap.get(entry.key);
    if (found === undefined) {
      into.push({ kind, subject: entry.key, expected: entry.value, actual: 'missing' });
    } else if (found !== entry.value) {
      into.push({ kind, subject: entry.key, expected: entry.value, actual: found });
    }
  }
  for (const entry of actual) {
    if (!expectedMap.has(entry.key)) {
      into.push({ kind, subject: entry.key, expected: 'undeclared', actual: entry.value });
    }
  }
}

/** Throws with every difference when the live schema does not match. */
export async function assertSchemaMatchesDeclaration(pool: Pool): Promise<void> {
  const differences = await compareSchema(pool);
  if (differences.length === 0) return;
  const detail = differences
    .map((d) => `${d.kind} ${d.subject}: expected [${d.expected}], found [${d.actual}]`)
    .join('\n  ');
  throw new Error(`the live schema does not match the declaration:\n  ${detail}`);
}
