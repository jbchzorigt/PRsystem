import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { DECLARED_TABLES } from './schema';
import { EXPECTED_SCHEMA_SNAPSHOT } from './schema-snapshot';
import type { SchemaSnapshot } from './schema-snapshot';
import type { SchemaDifference } from './schema-difference';

/** Only the parts of the snapshot this comparison reads. */
export type SchemaSnapshotInput = Pick<SchemaSnapshot, 'columns' | 'constraints'>;

/**
 * The Drizzle declaration, projected into the same vocabulary as the canonical
 * snapshot.
 *
 * Without this, `schema.ts` was consulted for one thing only — the list of table
 * names — so a change to a declared column's type, nullability, default or key
 * passed the gate silently: the snapshot still matched the database, and nothing
 * ever compared the two declarations to each other. The projection closes that
 * by making the DSL's own statements checkable.
 *
 * It covers exactly what the DSL expresses. Partial and expression indexes,
 * exclusion constraints, check text, foreign keys and partitioning stay in the
 * snapshot, which is what "SQL-only" means here.
 */

const dialect = new PgDialect();

export interface ProjectedColumn {
  readonly table: string;
  readonly column: string;
  /** Same `type | nullability | default | identity | generated` shape as the snapshot. */
  readonly shape: string;
}

export interface ProjectedConstraint {
  readonly table: string;
  readonly name: string;
  /** `p` primary key or `u` unique — the two the DSL can state. */
  readonly kind: 'p' | 'u';
  readonly definition: string;
}

export interface SchemaProjection {
  readonly columns: readonly ProjectedColumn[];
  readonly constraints: readonly ProjectedConstraint[];
}

/** PostgreSQL's `pg_attribute.attidentity` letter for a Drizzle identity kind. */
function identityLetter(type: string | undefined): string {
  if (type === undefined) return '';
  return type === 'always' ? 'a' : 'd';
}

export function drizzleProjection(): SchemaProjection {
  const columns: ProjectedColumn[] = [];
  const constraints: ProjectedConstraint[] = [];

  for (const table of DECLARED_TABLES) {
    const config = getTableConfig(table);
    const qualified = `${config.schema ?? 'public'}.${config.name}`;
    const simplePrimary: string[] = [];

    for (const column of config.columns) {
      // Rendered through the dialect, so a default declared as `sql` produces
      // the exact text PostgreSQL reports rather than a JavaScript value
      // guessed into SQL.
      const defaultText =
        column.default === undefined
          ? ''
          : dialect.sqlToQuery(column.default as Parameters<typeof dialect.sqlToQuery>[0]).sql;
      const identity = (column as unknown as { generatedIdentity?: { type?: string } })
        .generatedIdentity;

      columns.push({
        table: qualified,
        column: column.name,
        shape: [
          column.getSQLType(),
          column.notNull ? 'NOT NULL' : 'NULL',
          defaultText === '' ? 'no default' : `default ${defaultText}`,
          identity === undefined ? 'no identity' : `identity ${identityLetter(identity.type)}`,
          // The DSL has no generated-column form, so every declared column is
          // ordinary. A generated column appearing in the database is caught as
          // a snapshot difference.
          'not generated',
        ].join(' | '),
      });

      if (column.primary) simplePrimary.push(column.name);
    }

    if (simplePrimary.length > 0) {
      constraints.push({
        table: qualified,
        name: `${config.name}_pkey`,
        kind: 'p',
        definition: `PRIMARY KEY (${simplePrimary.join(', ')})`,
      });
    }
    for (const key of config.primaryKeys) {
      constraints.push({
        table: qualified,
        name: key.getName(),
        kind: 'p',
        definition: `PRIMARY KEY (${key.columns.map((column) => column.name).join(', ')})`,
      });
    }
    for (const unique of config.uniqueConstraints) {
      constraints.push({
        table: qualified,
        name: unique.name ?? '',
        kind: 'u',
        definition: `UNIQUE (${unique.columns.map((column) => column.name).join(', ')})`,
      });
    }
  }

  return { columns, constraints };
}

/**
 * Compares the Drizzle declaration against the canonical snapshot.
 *
 * Both are declarations, so this runs without a database — and it is the check
 * that stops a `schema.ts` edit from passing while the snapshot still agrees
 * with the live database.
 */
export function compareDeclarationToSnapshot(): SchemaDifference[] {
  return diffDeclarations(drizzleProjection(), EXPECTED_SCHEMA_SNAPSHOT);
}

/**
 * The comparison itself, over supplied inputs.
 *
 * Separated so a test can hand it a deliberately altered projection and prove
 * the difference is reported. Editing `schema.ts` at runtime is not possible, so
 * without this seam "a schema.ts change is caught" would be an assertion about
 * code nothing exercises.
 */
export function diffDeclarations(
  projection: SchemaProjection,
  snapshot: SchemaSnapshotInput,
): SchemaDifference[] {
  const differences: SchemaDifference[] = [];
  const declaredTables = new Set(projection.columns.map((column) => column.table));

  const snapshotColumns = new Map(
    snapshot.columns.map((column) => [`${column.table}.${column.column}`, column]),
  );

  for (const column of projection.columns) {
    const key = `${column.table}.${column.column}`;
    const snapshot = snapshotColumns.get(key);
    if (snapshot === undefined) {
      differences.push({
        kind: 'declaration-column',
        subject: key,
        expected: 'present in the snapshot',
        actual: 'declared in schema.ts only',
      });
      continue;
    }
    if (snapshot.shape !== column.shape) {
      differences.push({
        kind: 'declaration-column',
        subject: key,
        expected: snapshot.shape,
        actual: column.shape,
      });
    }
  }

  const projected = new Set(projection.columns.map((column) => `${column.table}.${column.column}`));
  for (const column of snapshot.columns) {
    if (!declaredTables.has(column.table)) continue;
    const key = `${column.table}.${column.column}`;
    if (!projected.has(key)) {
      differences.push({
        kind: 'declaration-column',
        subject: key,
        expected: 'declared in schema.ts',
        actual: 'present in the snapshot only',
      });
    }
  }

  // Keys, for the two kinds the DSL can state. Everything else — foreign keys,
  // checks, exclusions — is snapshot-only by design and is not projected.
  const snapshotKeys = new Map(
    snapshot.constraints
      .filter((c) => (c.kind === 'p' || c.kind === 'u') && declaredTables.has(c.table))
      .map((c) => [`${c.table}.${c.name}`, `${c.kind} ${c.definition}`]),
  );
  const projectedKeys = new Map(
    projection.constraints.map((c) => [`${c.table}.${c.name}`, `${c.kind} ${c.definition}`]),
  );

  for (const [key, value] of projectedKeys) {
    const snapshot = snapshotKeys.get(key);
    if (snapshot === undefined) {
      differences.push({
        kind: 'declaration-key',
        subject: key,
        expected: 'present in the snapshot',
        actual: value,
      });
    } else if (snapshot !== value) {
      differences.push({
        kind: 'declaration-key',
        subject: key,
        expected: snapshot,
        actual: value,
      });
    }
  }
  for (const [key, value] of snapshotKeys) {
    if (!projectedKeys.has(key)) {
      differences.push({
        kind: 'declaration-key',
        subject: key,
        expected: 'declared in schema.ts',
        actual: `${value} (snapshot only)`,
      });
    }
  }

  return differences;
}
