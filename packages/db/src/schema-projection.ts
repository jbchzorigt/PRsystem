import { PgDialect, getTableConfig } from 'drizzle-orm/pg-core';
import { DECLARED_TABLES } from './schema';
import { EXPECTED_SCHEMA_SNAPSHOT } from './schema-snapshot';
import type { SchemaSnapshot } from './schema-snapshot';
import type { SchemaDifference } from './schema-difference';

/** Only the parts of the snapshot this comparison reads. */
export type SchemaSnapshotInput = Pick<
  SchemaSnapshot,
  'columns' | 'constraints' | 'indexes' | 'identitySequences' | 'rls' | 'policies' | 'enums'
>;

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

export interface ProjectedIdentitySequence {
  readonly table: string;
  readonly column: string;
  readonly sequence: string;
  readonly shape: string;
}

export interface ProjectedRls {
  readonly table: string;
  readonly enabled: boolean;
}

export interface ProjectedPolicy {
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

/**
 * A PostgreSQL enum type, with its labels in declaration order.
 *
 * `enumValues` was classified as a Drizzle-side hint. On a `pgEnum` column it is
 * the label list PostgreSQL stores in `pg_enum`: it decides which values the
 * column accepts and the order it sorts in, and both are persistent. The
 * TypeScript-only `text({ enum })` hint genuinely is Drizzle-side, so the two
 * are distinguished by the column carrying a `PgEnum` object rather than by the
 * presence of `enumValues`.
 */
export interface ProjectedEnum {
  readonly name: string;
  /** Labels in declaration order, which is the order PostgreSQL sorts by. */
  readonly labels: string;
}

export interface SchemaProjection {
  /**
   * Every declared table, whatever its column count.
   *
   * Derived from the declaration itself rather than from the projected columns.
   * The reverse half of every comparison is scoped to "tables the declaration
   * knows about", and deriving that set from columns meant a table with none was
   * not in it — so removing the last column from a declared table filtered its
   * own snapshot rows out of the comparison and returned an empty difference.
   */
  readonly tables: readonly string[];
  readonly columns: readonly ProjectedColumn[];
  readonly constraints: readonly ProjectedConstraint[];
  /** Standalone indexes only; the ones a key creates are projected as constraints. */
  readonly indexes: readonly ProjectedIndex[];
  readonly identitySequences: readonly ProjectedIdentitySequence[];
  readonly rls: readonly ProjectedRls[];
  readonly policies: readonly ProjectedPolicy[];
  readonly enums: readonly ProjectedEnum[];
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

/**
 * Renders a `SQL` fragment as the text PostgreSQL would report.
 *
 * A parameterised fragment is refused. `sqlToQuery` returns the text with `$1`
 * placeholders and the values separately, so two declarations differing only by
 * a literal rendered identically and a value change was silent — in a generated
 * expression, a check, an expression index or a partial predicate. A schema
 * declaration has no parameters: PostgreSQL stores the literal, so the
 * declaration should carry the literal too.
 */
function render(fragment: unknown): string {
  const query = dialect.sqlToQuery(fragment as Parameters<typeof dialect.sqlToQuery>[0]);
  if (query.params.length > 0) {
    throw new Error(
      `schema fragment "${query.sql}" is parameterised (${String(query.params.length)} ` +
        'parameter(s)). Schema declarations are compared as text and PostgreSQL stores the ' +
        'literal, so a parameter would make a value change invisible: write the literal',
    );
  }
  return query.sql;
}

/**
 * The role names a policy is granted to.
 *
 * `to` is either a role name, a `PgRole` object, or an array of those.
 * `String(pgRole('role_a'))` is `[object Object]`, so stringifying the value
 * generically made every `PgRole` target render identically: two policies
 * granted to genuinely different roles produced the same text and a change of
 * grantee was an empty diff. Anything that is neither a name nor a `PgRole` is
 * refused rather than stringified, because a target nothing can name is a target
 * nothing can compare.
 */
function renderPolicyRoles(to: unknown): string {
  const one = (target: unknown): string => {
    if (typeof target === 'string') return target;
    if (
      typeof target === 'object' &&
      target !== null &&
      'name' in target &&
      typeof (target as { name: unknown }).name === 'string'
    ) {
      return (target as { name: string }).name;
    }
    throw new Error(
      `policy target ${JSON.stringify(target)} is neither a role name nor a pgRole: a target ` +
        'that cannot be named cannot be compared, so it is refused rather than stringified',
    );
  };
  return Array.isArray(to) ? to.map(one).join(', ') : one(to);
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
  const identitySequences: ProjectedIdentitySequence[] = [];
  const rls: ProjectedRls[] = [];
  const policies: ProjectedPolicy[] = [];
  const declaredTables: string[] = [];
  const enums = new Map<string, string>();

  for (const table of tables) {
    const config = getTableConfig(table);
    const qualified = `${config.schema ?? 'public'}.${config.name}`;
    declaredTables.push(qualified);
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
            : // Through `render`, so a parameterised default is refused rather than
              // projected as `default $1`. Two genuinely different defaults
              // rendered identically that way, and PostgreSQL stores the literal.
              render(column.default);
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

      // A `pgEnum` column carries the enum object itself; a `text({ enum })`
      // column carries only `enumValues`. The first is a PostgreSQL type whose
      // labels and their order are persistent; the second is a TypeScript hint
      // that leaves no trace in the catalogue.
      const declaredEnum = (
        column as unknown as {
          enum?: { enumName?: unknown; enumValues?: unknown; schema?: unknown };
        }
      ).enum;
      if (
        declaredEnum !== undefined &&
        typeof declaredEnum.enumName === 'string' &&
        Array.isArray(declaredEnum.enumValues)
      ) {
        const name =
          `${typeof declaredEnum.schema === 'string' ? declaredEnum.schema : 'public'}.` +
          declaredEnum.enumName;
        const labels = (declaredEnum.enumValues as unknown[]).map(String).join(', ');
        const seen = enums.get(name);
        if (seen !== undefined && seen !== labels) {
          throw new Error(
            `enum type ${name} is declared twice with different labels ([${seen}] and ` +
              `[${labels}]): PostgreSQL holds one label list per type, so the declaration ` +
              'contradicts itself',
          );
        }
        enums.set(name, labels);
      }

      // The identity's backing sequence. `attidentity` says a column is an
      // identity; it says nothing about the sequence's start, step or bounds,
      // all of which are persistent and all of which changed silently.
      const identityConfig = (
        column as unknown as {
          generatedIdentity?: {
            sequenceName?: string;
            sequenceOptions?: {
              startWith?: number | string;
              increment?: number | string;
              minValue?: number | string;
              maxValue?: number | string;
              cache?: number | string;
              cycle?: boolean;
            };
          };
        }
      ).generatedIdentity;
      if (identityConfig !== undefined) {
        const options = identityConfig.sequenceOptions ?? {};
        identitySequences.push({
          table: qualified,
          column: column.name,
          // PostgreSQL's default name for an identity sequence.
          sequence: `${config.schema ?? 'public'}.${identityConfig.sequenceName ?? `${config.name}_${column.name}_seq`}`,
          shape: [
            `start ${String(options.startWith ?? 1)}`,
            `increment ${String(options.increment ?? 1)}`,
            `min ${String(options.minValue ?? 1)}`,
            `max ${String(options.maxValue ?? '9223372036854775807')}`,
            `cache ${String(options.cache ?? 1)}`,
            options.cycle === true ? 'cycle' : 'no cycle',
          ].join(' | '),
        });
      }

      // A column-level `.unique()` is a table constraint PostgreSQL records
      // exactly like a table-level one. Reading only `config.uniqueConstraints`
      // meant declaring uniqueness on the column produced nothing at all.
      const uniqueColumn = column as unknown as {
        isUnique?: boolean;
        uniqueName?: string;
        uniqueType?: string;
      };
      if (uniqueColumn.isUnique === true) {
        constraints.push({
          table: qualified,
          name: uniqueColumn.uniqueName ?? `${config.name}_${column.name}_unique`,
          kind: 'u',
          definition:
            `UNIQUE${uniqueColumn.uniqueType === 'not distinct' ? ' NULLS NOT DISTINCT' : ''} ` +
            `(${column.name})`,
        });
      }
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

    // Row level security. `FORCE ROW LEVEL SECURITY` stays SQL-only — Drizzle
    // 0.45.2 has no form for it — but ordinary enablement and the policies
    // themselves are expressible, and calling them unsupported left the two
    // descriptions of the same rule uncompared.
    const tableRls = (config as unknown as { enableRLS?: boolean }).enableRLS;
    if (tableRls === true) rls.push({ table: qualified, enabled: true });

    for (const policy of (config as unknown as { policies?: readonly unknown[] }).policies ?? []) {
      const declared = policy as {
        name?: string;
        as?: string;
        for?: string;
        to?: unknown;
        using?: unknown;
        withCheck?: unknown;
      };
      const roles = declared.to === undefined ? 'public' : renderPolicyRoles(declared.to);
      policies.push({
        table: qualified,
        name: declared.name ?? '',
        definition:
          `AS ${(declared.as ?? 'permissive').toUpperCase()} ` +
          `FOR ${(declared.for ?? 'all').toUpperCase()} ` +
          `TO ${roles}` +
          (declared.using === undefined ? '' : ` USING (${render(declared.using)})`) +
          (declared.withCheck === undefined ? '' : ` WITH CHECK (${render(declared.withCheck)})`),
      });
    }
  }

  return {
    tables: declaredTables,
    columns,
    constraints,
    indexes,
    identitySequences,
    rls,
    policies,
    enums: [...enums].map(([name, labels]) => ({ name, labels })),
  };
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
  // From the declared-table inventory, not from the projected columns. A table
  // with no columns was absent from a column-derived set, and every reverse
  // comparison is scoped by it — so dropping a declared table's last column
  // filtered its own snapshot rows out and returned an empty difference.
  const declaredTables = new Set(projection.tables);

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

  // Identity sequences, RLS enablement and policies, each compared both ways.
  compareKeyed(
    differences,
    'declaration-identity',
    projection.identitySequences.map((entry) => [
      `${entry.table}.${entry.column}`,
      `${entry.sequence} | ${entry.shape}`,
    ]),
    snapshot.identitySequences
      .filter((entry) => declaredTables.has(entry.table))
      .map((entry) => [`${entry.table}.${entry.column}`, `${entry.sequence} | ${entry.shape}`]),
  );

  compareKeyed(
    differences,
    'declaration-rls',
    projection.rls.map((entry) => [entry.table, String(entry.enabled)]),
    snapshot.rls
      .filter((entry) => declaredTables.has(entry.table) && entry.enabled)
      .map((entry) => [entry.table, String(entry.enabled)]),
  );

  compareKeyed(
    differences,
    'declaration-enum',
    projection.enums.map((entry) => [entry.name, entry.labels]),
    snapshot.enums.map((entry) => [entry.name, entry.labels]),
  );

  compareKeyed(
    differences,
    'declaration-policy',
    projection.policies.map((entry) => [`${entry.table}.${entry.name}`, entry.definition]),
    snapshot.policies
      .filter((entry) => declaredTables.has(entry.table))
      .map((entry) => [`${entry.table}.${entry.name}`, entry.definition]),
  );

  return differences;
}

/** Compares two keyed sets in both directions. */
function compareKeyed(
  into: SchemaDifference[],
  kind: string,
  projected: readonly (readonly [string, string])[],
  snapshot: readonly (readonly [string, string])[],
): void {
  const snapshotMap = new Map(snapshot);
  const projectedMap = new Map(projected);
  for (const [key, value] of projectedMap) {
    const expected = snapshotMap.get(key);
    if (expected === undefined) {
      into.push({ kind, subject: key, expected: 'present in the snapshot', actual: value });
    } else if (expected !== value) {
      into.push({ kind, subject: key, expected, actual: value });
    }
  }
  for (const [key, value] of snapshotMap) {
    if (!projectedMap.has(key)) {
      into.push({
        kind,
        subject: key,
        expected: 'declared in schema.ts',
        actual: `${value} (snapshot only)`,
      });
    }
  }
}
