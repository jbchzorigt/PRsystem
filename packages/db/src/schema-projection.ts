import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { DECLARED_TABLES } from './schema';
import { EXPECTED_SCHEMA_SNAPSHOT } from './schema-snapshot';
import type { SchemaSnapshot } from './schema-snapshot';
import type { SchemaDifference } from './schema-difference';

/** Only the parts of the snapshot this comparison reads. */
export type SchemaSnapshotInput = Pick<SchemaSnapshot, 'columns' | 'constraints' | 'indexes'>;

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
 * It projects every *persistent* property the DSL expresses and the canonical
 * snapshot can verify: column type, nullability, default, identity, generated
 * expression, primary keys, unique constraints including `NULLS NOT DISTINCT`,
 * foreign keys with both referential actions, check predicates, and indexes with
 * their uniqueness, method, column order, NULL ordering, operator class, storage
 * parameters and `ONLY` flag.
 *
 * One declared option is construction-only: `concurrently` changes how an index
 * is built and leaves no trace in `pg_get_indexdef`, so nothing downstream could
 * verify it. It is refused rather than ignored — a declaration nothing can check
 * is worse than no declaration, because it reads as covered.
 *
 * What stays snapshot-only is what the DSL cannot express at all: RLS and
 * policies, grants, triggers, partitioning and exclusion constraints. The reason
 * for each is recorded in `schema-snapshot.ts`.
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
  /** `p` primary key, `u` unique, `f` foreign key, `c` check. */
  readonly kind: 'p' | 'u' | 'f' | 'c';
  readonly definition: string;
}

export interface ProjectedIndex {
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

export interface SchemaProjection {
  readonly columns: readonly ProjectedColumn[];
  readonly constraints: readonly ProjectedConstraint[];
  /** Standalone indexes only; the ones a key creates are projected as constraints. */
  readonly indexes: readonly ProjectedIndex[];
}

/** PostgreSQL's `pg_attribute.attidentity` letter for a Drizzle identity kind. */
function identityLetter(type: string | undefined): string {
  if (type === undefined) return '';
  return type === 'always' ? 'a' : 'd';
}

/**
 * PostgreSQL's `pg_attribute.attgenerated` letter.
 *
 * Only `s` (stored) exists in PostgreSQL 17; virtual generated columns are not
 * implemented, so any declared generated column is stored.
 */
function generatedLetter(_type: string | undefined): string {
  return 's';
}

/** Renders a `SQL` fragment as the text PostgreSQL would report. */
function render(fragment: unknown): string {
  return dialect.sqlToQuery(fragment as Parameters<typeof dialect.sqlToQuery>[0]).sql;
}

/** The parts of Drizzle's index configuration this projection reads. */
interface IndexConfig {
  readonly name?: string;
  readonly unique?: boolean;
  readonly only?: boolean;
  readonly concurrently?: boolean;
  readonly method?: string;
  readonly with?: Record<string, unknown>;
  readonly where?: unknown;
  readonly columns?: readonly unknown[];
}

interface IndexedColumn {
  readonly name?: string;
  readonly indexConfig?: {
    readonly order?: 'asc' | 'desc';
    readonly nulls?: 'first' | 'last';
    readonly opClass?: string;
  };
}

/**
 * One index column, spelled the way `pg_get_indexdef` spells it.
 *
 * PostgreSQL prints only what deviates from the default: ascending order and
 * the NULL ordering implied by the direction are omitted. Rendering the column
 * name alone dropped direction, NULL ordering and operator class entirely, so a
 * change to any of them produced an empty diff while changing which rows the
 * index can serve and in what order.
 */
function renderIndexColumn(column: unknown): string {
  if (typeof column !== 'object' || column === null || !('name' in column)) {
    // An expression index: the fragment is its own text.
    return render(column);
  }
  const typed = column as IndexedColumn;
  const order = typed.indexConfig?.order ?? 'asc';
  const nulls = typed.indexConfig?.nulls ?? (order === 'desc' ? 'first' : 'last');
  const defaultNulls = order === 'desc' ? 'first' : 'last';

  return (
    `${typed.name ?? ''}` +
    (typed.indexConfig?.opClass === undefined ? '' : ` ${typed.indexConfig.opClass}`) +
    (order === 'desc' ? ' DESC' : '') +
    (nulls === defaultNulls ? '' : ` NULLS ${nulls.toUpperCase()}`)
  );
}

/** Index storage parameters, in PostgreSQL's `key='value'` form. */
function renderStorage(options: Record<string, unknown>): string {
  return Object.entries(options)
    .map(([key, value]) => `${key}='${String(value)}'`)
    .join(', ');
}

/** Anything `getTableConfig` accepts. */
export type ProjectableTable = Parameters<typeof getTableConfig>[0];

/**
 * Projects the declared tables.
 *
 * Takes the tables as an argument so a test can hand it a *declaration* it built
 * itself and compare the result. Mutating an already-produced projection proves
 * only that `diffDeclarations` compares two objects; it says nothing about
 * whether extraction reads the property at all, which is how `onUpdate`,
 * `NULLS NOT DISTINCT`, generated expressions and index ordering came to be
 * silently dropped.
 */
export function drizzleProjection(
  tables: readonly ProjectableTable[] = DECLARED_TABLES,
): SchemaProjection {
  const columns: ProjectedColumn[] = [];
  const constraints: ProjectedConstraint[] = [];
  const indexes: ProjectedIndex[] = [];

  for (const table of tables) {
    const config = getTableConfig(table);
    const qualified = `${config.schema ?? 'public'}.${config.name}`;
    const simplePrimary: string[] = [];

    for (const column of config.columns) {
      // Rendered through the dialect, so a default declared as `sql` produces
      // the exact text PostgreSQL reports rather than a JavaScript value
      // guessed into SQL.
      const generated = (
        column as unknown as { generated?: { as?: unknown; type?: string } | undefined }
      ).generated;
      // A generated column's expression is what PostgreSQL stores in
      // `pg_attrdef`, so it lands in the same slot the live query reads it from.
      // Without this the expression was projected nowhere and a change to it
      // produced an empty diff.
      const defaultText =
        generated !== undefined
          ? render(generated.as)
          : column.default === undefined
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
          generated === undefined
            ? 'not generated'
            : `generated ${generatedLetter(generated.type)}`,
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
      // NULLS NOT DISTINCT changes which rows the constraint rejects, and
      // PostgreSQL prints it. Dropping it made a real uniqueness change
      // invisible.
      const nullsNotDistinct =
        (unique as unknown as { nullsNotDistinct?: boolean }).nullsNotDistinct === true;
      constraints.push({
        table: qualified,
        name: unique.name ?? '',
        kind: 'u',
        definition:
          `UNIQUE${nullsNotDistinct ? ' NULLS NOT DISTINCT' : ''} ` +
          `(${unique.columns.map((column) => column.name).join(', ')})`,
      });
    }

    // Foreign keys, with their referential action. `NO ACTION` is PostgreSQL's
    // default and is the one form it does not print, so it is omitted here too.
    for (const foreignKey of config.foreignKeys) {
      const reference = foreignKey.reference();
      const foreignConfig = getTableConfig(reference.foreignTable);
      const foreignQualified = `${foreignConfig.schema ?? 'public'}.${foreignConfig.name}`;
      // Both referential actions. `ON UPDATE` was dropped entirely, so changing
      // it produced no difference at all. `NO ACTION` is PostgreSQL's default
      // and the one form it does not print, so it is omitted here too.
      const action = (value: string | undefined): string => (value ?? '').toUpperCase();
      const onDelete = action(foreignKey.onDelete);
      const onUpdate = action(foreignKey.onUpdate);
      const suffix = (keyword: string, value: string): string =>
        value === '' || value === 'NO ACTION' ? '' : ` ON ${keyword} ${value}`;
      constraints.push({
        table: qualified,
        name: foreignKey.getName(),
        kind: 'f',
        definition:
          `FOREIGN KEY (${reference.columns.map((column) => column.name).join(', ')}) ` +
          `REFERENCES ${foreignQualified}` +
          `(${reference.foreignColumns.map((column) => column.name).join(', ')})` +
          // PostgreSQL prints UPDATE before DELETE.
          suffix('UPDATE', onUpdate) +
          suffix('DELETE', onDelete),
      });
    }

    // Checks. The declaration carries the exact PostgreSQL text of the
    // predicate, so what is compared is the constraint itself rather than a
    // rendering of a JavaScript expression.
    for (const checkConstraint of config.checks) {
      constraints.push({
        table: qualified,
        name: checkConstraint.name,
        kind: 'c',
        definition: `CHECK (${render(checkConstraint.value)})`,
      });
    }

    for (const declared of config.indexes) {
      const built = declared.config as unknown as IndexConfig;

      if (built.concurrently === true) {
        // Construction-only: CREATE INDEX CONCURRENTLY leaves no trace in
        // pg_get_indexdef, so nothing downstream can verify it. Refused rather
        // than ignored — a declaration nothing checks reads as covered.
        throw new Error(
          `index ${built.name ?? '(unnamed)'} declares \`concurrently\`, which is a ` +
            'construction-only option with no persistent form: the snapshot cannot verify it',
        );
      }

      const columns = (built.columns ?? []).map((column) => renderIndexColumn(column));
      const storage = built.with === undefined ? '' : ` WITH (${renderStorage(built.with)})`;
      const where = built.where === undefined ? '' : ` WHERE (${render(built.where)})`;
      indexes.push({
        table: qualified,
        name: built.name ?? '',
        definition:
          `CREATE ${built.unique === true ? 'UNIQUE ' : ''}INDEX ${built.name ?? ''} ` +
          `ON ${built.only === true ? 'ONLY ' : ''}${qualified} ` +
          `USING ${built.method ?? 'btree'} (${columns.join(', ')})${storage}${where}`,
      });
    }
  }

  return { columns, constraints, indexes };
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

  // Every constraint kind the DSL can state: primary keys, uniques, foreign
  // keys with their action, and checks. Only exclusion constraints remain
  // snapshot-only, because Drizzle 0.45.2 has no faithful form for them.
  const PROJECTED_KINDS = new Set(['p', 'u', 'f', 'c']);
  const snapshotKeys = new Map(
    snapshot.constraints
      .filter((c) => PROJECTED_KINDS.has(c.kind) && declaredTables.has(c.table))
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

  // Standalone indexes. The ones a primary key or unique constraint creates are
  // already compared as constraints, and comparing them again here would ask
  // Drizzle to declare an index it never writes.
  const constraintBacked = new Set(
    snapshot.constraints.filter((c) => c.kind === 'p' || c.kind === 'u').map((c) => c.name),
  );
  const snapshotIndexes = new Map(
    snapshot.indexes
      .filter((i) => declaredTables.has(i.table) && !constraintBacked.has(i.name))
      .map((i) => [`${i.table}.${i.name}`, i.definition]),
  );
  const projectedIndexes = new Map(
    projection.indexes.map((i) => [`${i.table}.${i.name}`, i.definition]),
  );

  for (const [key, value] of projectedIndexes) {
    const snapshotDefinition = snapshotIndexes.get(key);
    if (snapshotDefinition === undefined) {
      differences.push({
        kind: 'declaration-index',
        subject: key,
        expected: 'present in the snapshot',
        actual: value,
      });
    } else if (snapshotDefinition !== value) {
      differences.push({
        kind: 'declaration-index',
        subject: key,
        expected: snapshotDefinition,
        actual: value,
      });
    }
  }
  for (const [key, value] of snapshotIndexes) {
    if (!projectedIndexes.has(key)) {
      differences.push({
        kind: 'declaration-index',
        subject: key,
        expected: 'declared in schema.ts',
        actual: `${value} (snapshot only)`,
      });
    }
  }

  return differences;
}
