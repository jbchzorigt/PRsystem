import { is } from 'drizzle-orm';
import {
  PgDialect,
  PgRole,
  PgTable,
  getTableConfig,
  isPgEnum,
  isPgSchema,
  isPgSequence,
} from 'drizzle-orm/pg-core';
import { DECLARED_ENUMS, DECLARED_TABLES } from './schema';
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
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  /** Same `type | nullability | default | identity | generated` shape as the snapshot. */
  readonly shape: string;
}

export interface ProjectedConstraint {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /** `p` primary key, `u` unique, `f` foreign key, `c` check. */
  readonly kind: 'p' | 'u' | 'f' | 'c';
  readonly definition: string;
}

export interface ProjectedIndex {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly definition: string;
}

export interface ProjectedIdentitySequence {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly sequenceSchema: string;
  readonly sequence: string;
  readonly shape: string;
}

export interface ProjectedRls {
  readonly schema: string;
  readonly table: string;
  readonly enabled: boolean;
}

/**
 * A policy, kept in parts rather than as one rendered sentence.
 *
 * `TO ${roles.join(', ')}` is not injective: one role named `a, b` and the two
 * roles `a` and `b` produced the same text and grant different things. A role
 * name is an identifier and may contain any character, so no delimiter is safe —
 * the targets stay an ordered list and are compared as one.
 */
export interface ProjectedPolicy {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  /** `PERMISSIVE` or `RESTRICTIVE`. */
  readonly as: string;
  /** `ALL`, `SELECT`, `INSERT`, `UPDATE` or `DELETE`. */
  readonly command: string;
  /** Exact role names, in declaration order. */
  readonly to: readonly string[];
  readonly using: string | null;
  readonly withCheck: string | null;
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
  readonly schema: string;
  readonly name: string;
  /**
   * Labels in declaration order, which is the order PostgreSQL sorts by.
   *
   * A list, not joined text. A label is arbitrary text, so `['a, b']` and
   * `['a', 'b']` — one label containing a comma against two labels — joined to
   * the same string and were indistinguishable while being different types.
   */
  readonly labels: readonly string[];
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
  readonly tables: readonly { readonly schema: string; readonly table: string }[];
  readonly columns: readonly ProjectedColumn[];
  readonly constraints: readonly ProjectedConstraint[];
  /** Standalone indexes only; the ones a key creates are projected as constraints. */
  readonly indexes: readonly ProjectedIndex[];
  readonly identitySequences: readonly ProjectedIdentitySequence[];
  readonly rls: readonly ProjectedRls[];
  readonly policies: readonly ProjectedPolicy[];
  readonly enums: readonly ProjectedEnum[];
}

/**
 * A comparison key that no name can forge.
 *
 * Every key was a dotted concatenation — `${table}.${policy}`, and `table` was
 * itself `${schema}.${name}`. A schema, table, column, constraint, index or
 * policy name may contain a dot, so two genuinely different objects produced the
 * same key: one silently replaced the other while the maps were built, and a
 * changed predicate on the loser was reported as no difference at all. JSON of
 * the components round-trips, so the mapping from identity to key is injective.
 */
export function identityKey(...parts: readonly string[]): string {
  return JSON.stringify(parts);
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
 * The exact role names a policy is granted to, in order.
 *
 * `to` is either a role name, a `PgRole`, or an array of those.
 * `String(pgRole('role_a'))` is `[object Object]`, so stringifying the value
 * generically made every `PgRole` target render identically.
 *
 * Membership is decided by Drizzle's own `is(value, PgRole)`, not by the value
 * happening to carry a string `name`. A structural test accepts any
 * `{ name: string }` — a plain object, a table configuration, anything — and
 * silently reads a field that means something else, which is the same class of
 * mistake as reading `enumValues` off a text column.
 */
function policyRoleNames(to: unknown): string[] {
  const one = (target: unknown): string => {
    if (typeof target === 'string') return target;
    if (is(target, PgRole)) return (target as unknown as { name: string }).name;
    throw new Error(
      `policy target ${JSON.stringify(target)} is neither a role name nor a pgRole: a target ` +
        'that cannot be named cannot be compared, so it is refused rather than stringified',
    );
  };
  return Array.isArray(to) ? to.map(one) : [one(to)];
}

/** Anything shaped like a Drizzle `pgEnum`. */
export interface DeclaredEnum {
  readonly enumName: string;
  readonly enumValues: readonly string[];
  readonly schema?: string | undefined;
}

/** True for a Drizzle `pgEnum`, which is a callable carrying its own metadata. */
function isDeclaredEnum(value: unknown): value is DeclaredEnum {
  if (typeof value !== 'function' && (typeof value !== 'object' || value === null)) return false;
  const candidate = value as { enumName?: unknown; enumValues?: unknown };
  return typeof candidate.enumName === 'string' && Array.isArray(candidate.enumValues);
}

/**
 * Every PostgreSQL enum a module exports.
 *
 * The declared-enum inventory has to be checkable against the schema module
 * itself, or "every exported enum is registered" is a comment. Drizzle Kit reads
 * the module the same way, so an exported enum it would create is one this
 * projection must know about.
 */
export function exportedEnums(module: Record<string, unknown>): DeclaredEnum[] {
  return Object.values(module).filter(isDeclaredEnum);
}

/**
 * Drizzle's own name for what a value is, or undefined for a plain value.
 *
 * Drizzle stamps every entity class with `Symbol.for('drizzle:entityKind')`, and
 * that stamp is the only reliable answer to "what did the schema module just
 * export". Structural guesses accept lookalikes and, worse, miss entity kinds
 * nobody thought to guess at — which is how a standalone sequence became a
 * persistent object the gate could not see.
 */
const ENTITY_KIND = Symbol.for('drizzle:entityKind');

export function entityKindOf(value: unknown): string | undefined {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
    return undefined;
  }
  // `pgEnum` returns a callable with no constructor stamp; Drizzle identifies it
  // with `isPgEnum`, so it is named here the same way it is named there.
  if (isPgEnum(value)) return 'PgEnum';
  const prototype = Object.getPrototypeOf(value) as {
    constructor?: Record<symbol, unknown>;
  } | null;
  const kind = prototype?.constructor?.[ENTITY_KIND];
  return typeof kind === 'string' ? kind : undefined;
}

/** What a top-level schema-module export is, once classified. */
export interface ExportInventory {
  readonly tables: readonly ProjectableTable[];
  readonly enums: readonly DeclaredEnum[];
  readonly schemas: readonly string[];
}

/**
 * Classifies every top-level export of a schema module.
 *
 * Drizzle Kit loads this surface and creates what it finds, so anything it would
 * create that this projection does not understand is a persistent object the
 * gate cannot see. Every Drizzle entity must land in exactly one supported
 * category; an unsupported kind is refused by name rather than ignored.
 *
 * Standalone sequences, views, materialized views, roles and policies are all
 * persistent and none of them has a declaration, snapshot and live-catalogue
 * comparison here yet. They are rejected explicitly until they do — an
 * unsupported export that reads as accepted is the failure this replaces.
 */
export function classifyExports(module: Record<string, unknown>): ExportInventory {
  const tables: ProjectableTable[] = [];
  const enums: DeclaredEnum[] = [];
  const schemas: string[] = [];

  for (const [exported, value] of Object.entries(module)) {
    const kind = entityKindOf(value);
    if (kind === undefined) continue;

    if (kind === 'PgTable' || is(value, PgTable)) {
      tables.push(value as ProjectableTable);
      continue;
    }
    if (kind === 'PgEnum' && isDeclaredEnum(value)) {
      enums.push(value);
      continue;
    }
    if (isPgSchema(value)) {
      // Persistent, and created by the migration. It carries no shape of its own
      // beyond its name, and the comparator already governs which schemas exist.
      schemas.push((value as unknown as { schemaName: string }).schemaName);
      continue;
    }
    if (isPgSequence(value)) {
      throw new Error(
        `${exported} is a PgSequence, which Drizzle Kit creates and this projection does not ` +
          'compare: a standalone sequence has no declaration, snapshot or live-catalogue ' +
          'coverage here. Implement it or remove the export — an unsupported export that reads ' +
          'as accepted is a persistent object nothing checks',
      );
    }
    throw new Error(
      `${exported} is a ${kind}, which this projection does not classify. Every persistent ` +
        'Drizzle export must fall in exactly one supported category; an unclassified kind is ' +
        'refused rather than ignored',
    );
  }

  return { tables, enums, schemas };
}

/**
 * Holds the declared registries to what the schema module actually exports.
 *
 * By object identity, not by name. Comparing flattened qualified names accepted
 * a *different* enum registered under the same schema and name with different
 * labels: the inventory agreed, the projection carried the registered one, and
 * the exported one — the object Drizzle Kit would create — was never described.
 */
export function assertDeclaredInventory(
  module: Record<string, unknown>,
  registry: {
    readonly tables?: readonly ProjectableTable[];
    readonly enums?: readonly DeclaredEnum[];
  } = {},
): ExportInventory {
  const inventory = classifyExports(module);
  const tables = registry.tables ?? DECLARED_TABLES;
  const enums = registry.enums ?? DECLARED_ENUMS;

  const tableName = (table: ProjectableTable): string => {
    const config = getTableConfig(table);
    return `${config.schema ?? 'public'}.${config.name}`;
  };

  // Duplicates in the registry itself, by qualified name as well as by object.
  const byQualified = new Map<string, ProjectableTable>();
  for (const table of tables) {
    const qualified = tableName(table);
    if (byQualified.has(qualified)) {
      throw new Error(`table ${qualified} is declared twice in the table registry`);
    }
    byQualified.set(qualified, table);
  }

  const registeredTables = new Set<unknown>(tables);
  for (const table of inventory.tables) {
    if (!registeredTables.has(table)) {
      throw new Error(
        `the schema module exports table ${tableName(table)}, which the table registry does ` +
          'not hold. Drizzle Kit creates what the module exports, so an unregistered table is a ' +
          'table nothing compares',
      );
    }
  }
  const exportedTables = new Set<unknown>(inventory.tables);
  for (const table of tables) {
    if (!exportedTables.has(table)) {
      throw new Error(
        `the table registry holds ${tableName(table)}, which is not the object the schema ` +
          'module exports. The registry must name the same objects, by identity',
      );
    }
  }

  const registeredEnums = new Set<unknown>(enums);
  for (const declared of inventory.enums) {
    const identity = enumIdentity(declared);
    if (!registeredEnums.has(declared)) {
      throw new Error(
        `the schema module exports enum ${identity.schema}.${identity.name}, which is not the ` +
          'object the enum registry holds. Registration is by identity, so a same-named type ' +
          'with different labels is a different type',
      );
    }
  }
  const exportedEnumObjects = new Set<unknown>(inventory.enums);
  for (const declared of enums) {
    const identity = enumIdentity(declared);
    if (!exportedEnumObjects.has(declared)) {
      throw new Error(
        `the enum registry holds ${identity.schema}.${identity.name}, which is not the object ` +
          'the schema module exports',
      );
    }
  }

  return inventory;
}

/** A declared enum's identity: its schema and its name, kept apart. */
export function enumIdentity(declared: DeclaredEnum): { schema: string; name: string } {
  return { schema: declared.schema ?? 'public', name: declared.enumName };
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
  declaredEnums: readonly DeclaredEnum[] = DECLARED_ENUMS,
): SchemaProjection {
  const columns: ProjectedColumn[] = [];
  const constraints: ProjectedConstraint[] = [];
  const indexes: ProjectedIndex[] = [];
  const identitySequences: ProjectedIdentitySequence[] = [];
  const rls: ProjectedRls[] = [];
  const policies: ProjectedPolicy[] = [];
  const declaredTables: { schema: string; table: string }[] = [];
  const enums = new Map<string, { schema: string; name: string; labels: readonly string[] }>();

  /**
   * Registers one enum type, refusing a second declaration with other labels.
   *
   * PostgreSQL holds one label list per type, so two declarations that disagree
   * are a contradiction rather than something to merge — and merging is exactly
   * what let two partial declarations of one object look like a whole one.
   */
  const registerEnum = (declared: DeclaredEnum): void => {
    const identity = enumIdentity(declared);
    const key = identityKey(identity.schema, identity.name);
    const labels = [...declared.enumValues];
    const seen = enums.get(key);
    if (seen !== undefined && JSON.stringify(seen.labels) !== JSON.stringify(labels)) {
      throw new Error(
        `enum type ${identity.schema}.${identity.name} is declared twice with different labels (` +
          `${JSON.stringify(seen.labels)} and ${JSON.stringify(labels)}): PostgreSQL holds one ` +
          'label list per type, so the declaration contradicts itself',
      );
    }
    enums.set(key, { ...identity, labels });
  };

  // The declared inventory first. Discovery through table columns alone missed
  // an exported enum nothing references — which `CREATE TYPE` still creates and
  // Drizzle Kit still loads, so the declaration and the database disagreed with
  // an empty diff.
  for (const declared of declaredEnums) registerEnum(declared);

  for (const table of tables) {
    const config = getTableConfig(table);
    const schemaName = config.schema ?? 'public';
    const qualified = `${schemaName}.${config.name}`;
    const tableIdentity = { schema: schemaName, table: config.name };
    // Two declarations of one qualified table are a contradiction, not a merge.
    // Appending each declaration's columns unioned them into one apparent table
    // that could match the snapshot while neither declaration described it.
    if (
      declaredTables.some(
        (declared) => declared.schema === schemaName && declared.table === config.name,
      )
    ) {
      throw new Error(
        `table ${qualified} is declared twice. PostgreSQL holds one definition per qualified ` +
          'table, so two declarations contradict each other: unioning their columns would ' +
          'describe a table neither of them declares',
      );
    }
    declaredTables.push(tableIdentity);
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
        ...tableIdentity,
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
      const declaredEnum = (column as unknown as { enum?: unknown }).enum;
      if (isDeclaredEnum(declaredEnum)) registerEnum(declaredEnum);

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
          ...tableIdentity,
          column: column.name,
          // PostgreSQL's default name for an identity sequence.
          sequenceSchema: schemaName,
          sequence: identityConfig.sequenceName ?? `${config.name}_${column.name}_seq`,
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
          ...tableIdentity,
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
        ...tableIdentity,
        name: `${config.name}_pkey`,
        kind: 'p',
        definition: `PRIMARY KEY (${simplePrimary.join(', ')})`,
      });
    }
    for (const key of config.primaryKeys) {
      constraints.push({
        ...tableIdentity,
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
        ...tableIdentity,
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
        ...tableIdentity,
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
        ...tableIdentity,
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
        ...tableIdentity,
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
    if (tableRls === true) rls.push({ ...tableIdentity, enabled: true });

    for (const policy of (config as unknown as { policies?: readonly unknown[] }).policies ?? []) {
      const declared = policy as {
        name?: string;
        as?: string;
        for?: string;
        to?: unknown;
        using?: unknown;
        withCheck?: unknown;
      };
      policies.push({
        ...tableIdentity,
        name: declared.name ?? '',
        as: (declared.as ?? 'permissive').toUpperCase(),
        command: (declared.for ?? 'all').toUpperCase(),
        to: declared.to === undefined ? ['public'] : policyRoleNames(declared.to),
        using: declared.using === undefined ? null : render(declared.using),
        withCheck: declared.withCheck === undefined ? null : render(declared.withCheck),
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
    enums: [...enums.values()],
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
  const declaredTables = new Set(
    projection.tables.map((entry) => identityKey(entry.schema, entry.table)),
  );
  const inDeclaredTable = (entry: { schema: string; table: string }): boolean =>
    declaredTables.has(identityKey(entry.schema, entry.table));
  // Human-facing only. Every *key* below is an injective tuple; this is what the
  // difference is reported as, where a reader wants to see a name.
  const label = (...parts: readonly string[]): string => parts.join('.');

  compareKeyed(
    differences,
    'declaration-column',
    projection.columns.map((column) => [
      identityKey(column.schema, column.table, column.column),
      column.shape,
      label(column.schema, column.table, column.column),
    ]),
    snapshot.columns
      .filter(inDeclaredTable)
      .map((column) => [
        identityKey(column.schema, column.table, column.column),
        column.shape,
        label(column.schema, column.table, column.column),
      ]),
  );

  // Every constraint kind the DSL can state: primary keys, uniques, foreign
  // keys with their action, and checks. Only exclusion constraints remain
  // snapshot-only, because Drizzle 0.45.2 has no faithful form for them.
  const PROJECTED_KINDS = new Set(['p', 'u', 'f', 'c']);
  compareKeyed(
    differences,
    'declaration-key',
    projection.constraints.map((c) => [
      identityKey(c.schema, c.table, c.name),
      `${c.kind} ${c.definition}`,
      label(c.schema, c.table, c.name),
    ]),
    snapshot.constraints
      .filter((c) => PROJECTED_KINDS.has(c.kind) && inDeclaredTable(c))
      .map((c) => [
        identityKey(c.schema, c.table, c.name),
        `${c.kind} ${c.definition}`,
        label(c.schema, c.table, c.name),
      ]),
  );

  // Standalone indexes. The ones a primary key or unique constraint creates are
  // already compared as constraints, and comparing them again here would ask
  // Drizzle to declare an index it never writes.
  const constraintBacked = new Set(
    snapshot.constraints
      .filter((c) => c.kind === 'p' || c.kind === 'u')
      .map((c) => identityKey(c.schema, c.name)),
  );
  compareKeyed(
    differences,
    'declaration-index',
    projection.indexes.map((i) => [
      identityKey(i.schema, i.table, i.name),
      i.definition,
      label(i.schema, i.table, i.name),
    ]),
    snapshot.indexes
      .filter((i) => inDeclaredTable(i) && !constraintBacked.has(identityKey(i.schema, i.name)))
      .map((i) => [
        identityKey(i.schema, i.table, i.name),
        i.definition,
        label(i.schema, i.table, i.name),
      ]),
  );

  compareKeyed(
    differences,
    'declaration-identity',
    projection.identitySequences.map((entry) => [
      identityKey(entry.schema, entry.table, entry.column),
      identityKey(entry.sequenceSchema, entry.sequence, entry.shape),
      label(entry.schema, entry.table, entry.column),
    ]),
    snapshot.identitySequences
      .filter(inDeclaredTable)
      .map((entry) => [
        identityKey(entry.schema, entry.table, entry.column),
        identityKey(entry.sequenceSchema, entry.sequence, entry.shape),
        label(entry.schema, entry.table, entry.column),
      ]),
  );

  compareKeyed(
    differences,
    'declaration-rls',
    projection.rls.map((entry) => [
      identityKey(entry.schema, entry.table),
      String(entry.enabled),
      label(entry.schema, entry.table),
    ]),
    snapshot.rls
      .filter((entry) => inDeclaredTable(entry) && entry.enabled)
      .map((entry) => [
        identityKey(entry.schema, entry.table),
        String(entry.enabled),
        label(entry.schema, entry.table),
      ]),
  );

  compareKeyed(
    differences,
    'declaration-enum',
    projection.enums.map((entry) => [
      identityKey(entry.schema, entry.name),
      serialiseLabels(entry.labels),
      label(entry.schema, entry.name),
    ]),
    snapshot.enums.map((entry) => [
      identityKey(entry.schema, entry.name),
      serialiseLabels(entry.labels),
      label(entry.schema, entry.name),
    ]),
  );

  compareKeyed(
    differences,
    'declaration-policy',
    projection.policies.map((entry) => [
      identityKey(entry.schema, entry.table, entry.name),
      serialisePolicy(entry),
      label(entry.schema, entry.table, entry.name),
    ]),
    snapshot.policies
      .filter(inDeclaredTable)
      .map((entry) => [
        identityKey(entry.schema, entry.table, entry.name),
        serialisePolicy(entry),
        label(entry.schema, entry.table, entry.name),
      ]),
  );

  return differences;
}

/**
 * The canonical text for an ordered label list.
 *
 * JSON, so it round-trips: every label's boundaries and order survive, and no
 * character inside a label can forge one. Joining with a delimiter could not
 * say that — `['a, b']` and `['a', 'b']` produced the same string.
 */
export function serialiseLabels(labels: readonly string[]): string {
  return JSON.stringify(labels);
}

/**
 * The canonical text for a policy.
 *
 * Same reason as the labels: the target list is JSON rather than joined, so one
 * role named `a, b` and the two roles `a` and `b` are different values.
 */
export function serialisePolicy(policy: {
  readonly as: string;
  readonly command: string;
  readonly to: readonly string[];
  readonly using: string | null;
  readonly withCheck: string | null;
}): string {
  return JSON.stringify({
    as: policy.as,
    command: policy.command,
    to: policy.to,
    using: policy.using,
    withCheck: policy.withCheck,
  });
}

/**
 * Compares two keyed sets in both directions.
 *
 * Each entry is `[key, value, subject]`: the key is the injective tuple that
 * decides identity, and the subject is the readable name the difference is
 * reported under. Keeping them apart is the point — the readable name is
 * ambiguous by construction, and it used to be the key as well.
 *
 * A duplicate key is a contradiction rather than something to resolve by
 * insertion order: building a `Map` silently kept the last entry, which is how a
 * changed predicate on a colliding policy became no difference at all.
 */
function compareKeyed(
  into: SchemaDifference[],
  kind: string,
  projected: readonly (readonly [string, string, string])[],
  snapshot: readonly (readonly [string, string, string])[],
): void {
  const index = (entries: readonly (readonly [string, string, string])[], side: string) => {
    const map = new Map<string, { value: string; subject: string }>();
    for (const [key, value, subject] of entries) {
      if (map.has(key)) {
        throw new Error(`${side} declares ${subject} twice (${kind}); identities must be unique`);
      }
      map.set(key, { value, subject });
    }
    return map;
  };
  const snapshotMap = index(snapshot, 'the snapshot');
  const projectedMap = index(projected, 'the declaration');

  for (const [key, entry] of projectedMap) {
    const expected = snapshotMap.get(key);
    if (expected === undefined) {
      into.push({
        kind,
        subject: entry.subject,
        expected: 'present in the snapshot',
        actual: entry.value,
      });
    } else if (expected.value !== entry.value) {
      into.push({ kind, subject: entry.subject, expected: expected.value, actual: entry.value });
    }
  }
  for (const [key, entry] of snapshotMap) {
    if (!projectedMap.has(key)) {
      into.push({
        kind,
        subject: entry.subject,
        expected: 'declared in schema.ts',
        actual: `${entry.value} (snapshot only)`,
      });
    }
  }
}
