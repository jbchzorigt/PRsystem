import type { Pool } from 'pg';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { DECLARED_TABLES } from './schema';
import { EXPECTED_SCHEMA_SNAPSHOT } from './schema-snapshot';
import {
  compareDeclarationToSnapshot,
  identityKey,
  serialiseLabels,
  serialisePolicy,
} from './schema-projection';
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
  schema: string;
  table: string;
  column: string;
  type: string;
  not_null: boolean;
  default_expr: string;
  identity: string;
  generated: string;
}

interface LiveConstraint {
  schema: string;
  table: string;
  name: string;
  kind: string;
  definition: string;
}

interface LiveIndex {
  schema: string;
  table: string;
  name: string;
  definition: string;
}

/** Every root (non-partition) table the declaration says must exist. */
export function declaredTableNames(): { schema: string; table: string }[] {
  return DECLARED_TABLES.map((table) => {
    const config = getTableConfig(table);
    return { schema: config.schema ?? 'public', table: config.name };
  }).sort((a, b) => identityKey(a.schema, a.table).localeCompare(identityKey(b.schema, b.table)));
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
    await pool.query<{ schema: string; table: string }>(
      `SELECT n.nspname AS schema, c.relname AS table
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
          AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
        ORDER BY 1, 2`,
      [schemas],
    )
  ).rows;

  const declaredTables = declaredTableNames();
  const liveTableKeys = new Set(liveTables.map((row) => identityKey(row.schema, row.table)));
  const declaredTableKeys = new Set(
    declaredTables.map((row) => identityKey(row.schema, row.table)),
  );
  for (const entry of declaredTables) {
    if (!liveTableKeys.has(identityKey(entry.schema, entry.table))) {
      differences.push({
        kind: 'table',
        subject: `${entry.schema}.${entry.table}`,
        expected: 'present',
        actual: 'missing',
      });
    }
  }
  for (const entry of liveTables) {
    if (!declaredTableKeys.has(identityKey(entry.schema, entry.table))) {
      differences.push({
        kind: 'table',
        subject: `${entry.schema}.${entry.table}`,
        expected: 'undeclared',
        actual: 'present',
      });
    }
  }

  // --------------------------------------------------------------- columns
  const liveColumns = (
    await pool.query<LiveColumn>(
      `SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
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

  const liveColumnKey = (row: { schema: string; table: string; column: string }): string =>
    identityKey(row.schema, row.table, row.column);
  const liveColumnMap = new Map(liveColumns.map((row) => [liveColumnKey(row), row]));

  for (const expected of EXPECTED_SCHEMA_SNAPSHOT.columns) {
    const actual = liveColumnMap.get(liveColumnKey(expected));
    const subject = `${expected.schema}.${expected.table}.${expected.column}`;
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
  const declaredColumnKeys = new Set(EXPECTED_SCHEMA_SNAPSHOT.columns.map(liveColumnKey));
  for (const actual of liveColumns) {
    if (!declaredColumnKeys.has(liveColumnKey(actual))) {
      differences.push({
        kind: 'column',
        subject: `${actual.schema}.${actual.table}.${actual.column}`,
        expected: 'undeclared',
        actual: 'present',
      });
    }
  }

  // ----------------------------------------------------------- constraints
  const liveConstraints = (
    await pool.query<LiveConstraint>(
      `SELECT n.nspname AS schema, rel.relname AS table, con.conname AS name,
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
      key: identityKey(c.schema, c.table, c.name),
      value: `${c.kind} ${c.definition}`,
      subject: `${c.schema}.${c.table}.${c.name}`,
    })),
    liveConstraints.map((c) => ({
      key: identityKey(c.schema, c.table, c.name),
      value: `${c.kind} ${c.definition}`,
      subject: `${c.schema}.${c.table}.${c.name}`,
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
      `SELECT n.nspname AS schema, t.relname AS table, i.relname AS name,
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
      key: identityKey(i.schema, i.table, i.name),
      value: i.definition,
      subject: `${i.schema}.${i.table}.${i.name}`,
    })),
    liveIndexes.map((i) => ({
      key: identityKey(i.schema, i.table, i.name),
      value: i.definition,
      subject: `${i.schema}.${i.table}.${i.name}`,
    })),
  );

  // ---------------------------------------------------- identity sequences
  const liveIdentity = (
    await pool.query<{
      schema: string;
      table: string;
      column: string;
      sequence_schema: string;
      sequence: string;
      shape: string;
    }>(
      `SELECT n.nspname AS schema, t.relname AS table, a.attname AS column,
              sn.nspname AS sequence_schema, sc.relname AS sequence,
              'start ' || s.seqstart || ' | increment ' || s.seqincrement ||
              ' | min ' || s.seqmin || ' | max ' || s.seqmax ||
              ' | cache ' || s.seqcache ||
              CASE WHEN s.seqcycle THEN ' | cycle' ELSE ' | no cycle' END AS shape
         FROM pg_attribute a
         JOIN pg_class t ON t.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = t.relnamespace
         JOIN pg_depend d ON d.refobjid = t.oid AND d.refobjsubid = a.attnum
              AND d.classid = 'pg_class'::regclass AND d.deptype = 'i'
         JOIN pg_class sc ON sc.oid = d.objid AND sc.relkind = 'S'
         JOIN pg_namespace sn ON sn.oid = sc.relnamespace
         JOIN pg_sequence s ON s.seqrelid = sc.oid
        WHERE a.attidentity <> '' AND n.nspname = ANY($1)
        ORDER BY 1, 2`,
      [schemas],
    )
  ).rows;
  compareSets(
    differences,
    'identity-sequence',
    EXPECTED_SCHEMA_SNAPSHOT.identitySequences.map((entry) => ({
      key: identityKey(entry.schema, entry.table, entry.column),
      value: identityKey(entry.sequenceSchema, entry.sequence, entry.shape),
      subject: `${entry.schema}.${entry.table}.${entry.column}`,
    })),
    liveIdentity.map((entry) => ({
      key: identityKey(entry.schema, entry.table, entry.column),
      value: identityKey(entry.sequence_schema, entry.sequence, entry.shape),
      subject: `${entry.schema}.${entry.table}.${entry.column}`,
    })),
  );

  // ------------------------------------------------------------------- RLS
  const liveRls = (
    await pool.query<{ schema: string; table: string; enabled: boolean; forced: boolean }>(
      `SELECT n.nspname AS schema, c.relname AS table,
              c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ANY($1) AND c.relkind IN ('r', 'p')
          AND (c.relrowsecurity OR c.relforcerowsecurity)
        ORDER BY 1, 2`,
      [schemas],
    )
  ).rows;
  compareSets(
    differences,
    'rls',
    EXPECTED_SCHEMA_SNAPSHOT.rls.map((entry) => ({
      key: identityKey(entry.schema, entry.table),
      value: `enabled ${String(entry.enabled)} | forced ${String(entry.forced)}`,
      subject: `${entry.schema}.${entry.table}`,
    })),
    liveRls.map((entry) => ({
      key: identityKey(entry.schema, entry.table),
      value: `enabled ${String(entry.enabled)} | forced ${String(entry.forced)}`,
      subject: `${entry.schema}.${entry.table}`,
    })),
  );

  // ----------------------------------------------------------- enum types
  // Labels and their order are persistent: they decide which values a column of
  // the type accepts and how it sorts. Read straight from `pg_enum` in
  // `enumsortorder`, which is the order PostgreSQL itself uses.
  // `array_agg`, not `string_agg`: a label may contain any character, so joining
  // with a delimiter cannot say where one label ends. The driver returns a real
  // array and the comparison serialises it the same way both declarations do.
  const liveEnums = (
    await pool.query<{ schema: string; name: string; labels: string[] }>(
      `SELECT n.nspname AS schema, t.typname AS name,
              array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS labels
         FROM pg_type t
         JOIN pg_namespace n ON n.oid = t.typnamespace
         JOIN pg_enum e ON e.enumtypid = t.oid
        WHERE n.nspname = ANY($1)
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      [schemas],
    )
  ).rows;
  compareSets(
    differences,
    'enum',
    EXPECTED_SCHEMA_SNAPSHOT.enums.map((entry) => ({
      key: identityKey(entry.schema, entry.name),
      value: serialiseLabels(entry.labels),
      subject: `${entry.schema}.${entry.name}`,
    })),
    liveEnums.map((entry) => ({
      key: identityKey(entry.schema, entry.name),
      value: serialiseLabels(entry.labels),
      subject: `${entry.schema}.${entry.name}`,
    })),
  );

  // -------------------------------------------------------------- policies
  // `roles` stays an array. `array_to_string(roles, ', ')` made one role named
  // `a, b` indistinguishable from the two roles `a` and `b`, and those grant
  // different things.
  const livePolicies = (
    await pool.query<{
      schema: string;
      table: string;
      name: string;
      as: string;
      command: string;
      to: string[];
      using: string | null;
      with_check: string | null;
    }>(
      `SELECT schemaname AS schema, tablename AS table, policyname AS name,
              permissive AS as, cmd AS command,
              array(SELECT r::text FROM unnest(roles) AS r) AS to,
              qual AS using, with_check
         FROM pg_policies WHERE schemaname = ANY($1)
        ORDER BY 1, 2`,
      [schemas],
    )
  ).rows;
  compareSets(
    differences,
    'policy',
    EXPECTED_SCHEMA_SNAPSHOT.policies.map((entry) => ({
      key: identityKey(entry.schema, entry.table, entry.name),
      value: serialisePolicy(entry),
      subject: `${entry.schema}.${entry.table}.${entry.name}`,
    })),
    livePolicies.map((entry) => ({
      key: identityKey(entry.schema, entry.table, entry.name),
      subject: `${entry.schema}.${entry.table}.${entry.name}`,
      value: serialisePolicy({
        as: entry.as,
        command: entry.command,
        to: entry.to,
        using: entry.using,
        withCheck: entry.with_check,
      }),
    })),
  );

  return differences;
}

/**
 * Compares two keyed sets, recording missing, extra and differing entries.
 *
 * `key` is the injective identity tuple; `subject` is the readable name the
 * difference is reported under. They were the same dotted string, so a name
 * containing a dot let one object take another's place in the map.
 */
function compareSets(
  into: SchemaDifference[],
  kind: string,
  expected: readonly { key: string; value: string; subject: string }[],
  actual: readonly { key: string; value: string; subject: string }[],
): void {
  const index = (
    entries: readonly { key: string; value: string; subject: string }[],
    side: string,
  ) => {
    const map = new Map<string, { value: string; subject: string }>();
    for (const entry of entries) {
      if (map.has(entry.key)) {
        throw new Error(
          `${side} holds ${entry.subject} twice (${kind}); identities must be unique`,
        );
      }
      map.set(entry.key, { value: entry.value, subject: entry.subject });
    }
    return map;
  };
  const actualMap = index(actual, 'the live catalogue');
  const expectedMap = index(expected, 'the snapshot');

  for (const entry of expected) {
    const found = actualMap.get(entry.key);
    if (found === undefined) {
      into.push({ kind, subject: entry.subject, expected: entry.value, actual: 'missing' });
    } else if (found.value !== entry.value) {
      into.push({ kind, subject: entry.subject, expected: entry.value, actual: found.value });
    }
  }
  for (const entry of actual) {
    if (!expectedMap.has(entry.key)) {
      into.push({ kind, subject: entry.subject, expected: 'undeclared', actual: entry.value });
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
