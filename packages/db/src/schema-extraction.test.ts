import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgRole,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  assertDeclaredInventory,
  classifyExports,
  diffDeclarations,
  drizzleProjection,
  exportedEnums,
} from './schema-projection';
import type { ProjectableTable } from './schema-projection';

/**
 * Extraction fidelity, proved on real declarations.
 *
 * The mutation tests in `migrate.test.ts` alter an already-produced projection.
 * That proves `diffDeclarations` compares two objects and says nothing about
 * whether `drizzleProjection` reads a property at all — which is how `ON
 * UPDATE`, `NULLS NOT DISTINCT`, generated expressions and index ordering came
 * to be dropped silently while every test stayed green.
 *
 * Every case here builds two genuine Drizzle declarations that differ in exactly
 * one property and requires the projection to tell them apart.
 */

const probe = pgSchema('extraction_probe');

const parent = probe.table('parent', {
  id: integer('id').primaryKey(),
  other: integer('other'),
});

/** Projects one table and returns the entry for `name`, or undefined. */
function constraintOf(table: ProjectableTable, name: string) {
  return drizzleProjection([table]).constraints.find((entry) => entry.name === name);
}

function indexOf(table: ProjectableTable, name: string) {
  return drizzleProjection([table]).indexes.find((entry) => entry.name === name);
}

function columnOf(table: ProjectableTable, name: string) {
  return drizzleProjection([table]).columns.find((entry) => entry.column === name);
}

describe('foreign-key referential actions', () => {
  const withoutOnUpdate = probe.table(
    'fk_a',
    { id: integer('id').primaryKey(), pid: integer('pid') },
    (t) => [
      foreignKey({ name: 'probe_fk', columns: [t.pid], foreignColumns: [parent.id] }).onDelete(
        'restrict',
      ),
    ],
  );
  const withOnUpdate = probe.table(
    'fk_b',
    { id: integer('id').primaryKey(), pid: integer('pid') },
    (t) => [
      foreignKey({ name: 'probe_fk', columns: [t.pid], foreignColumns: [parent.id] })
        .onDelete('restrict')
        .onUpdate('cascade'),
    ],
  );

  it('projects ON UPDATE, so adding one is not an empty diff', () => {
    const a = constraintOf(withoutOnUpdate, 'probe_fk')?.definition;
    const b = constraintOf(withOnUpdate, 'probe_fk')?.definition;
    expect(a).not.toBe(b);
    expect(b).toContain('ON UPDATE CASCADE');
    expect(a).not.toContain('ON UPDATE');
  });

  it('prints ON UPDATE before ON DELETE, as PostgreSQL does', () => {
    const definition = constraintOf(withOnUpdate, 'probe_fk')?.definition ?? '';
    expect(definition.indexOf('ON UPDATE')).toBeLessThan(definition.indexOf('ON DELETE'));
  });

  it('omits NO ACTION, which PostgreSQL does not print', () => {
    const plain = probe.table(
      'fk_c',
      { id: integer('id').primaryKey(), pid: integer('pid') },
      (t) => [
        foreignKey({ name: 'probe_fk', columns: [t.pid], foreignColumns: [parent.id] })
          .onDelete('no action')
          .onUpdate('no action'),
      ],
    );
    expect(constraintOf(plain, 'probe_fk')?.definition).toBe(
      'FOREIGN KEY (pid) REFERENCES extraction_probe.parent(id)',
    );
  });

  it('projects the referenced columns, so repointing the key is not an empty diff', () => {
    const repointed = probe.table(
      'fk_d',
      { id: integer('id').primaryKey(), pid: integer('pid') },
      (t) => [foreignKey({ name: 'probe_fk', columns: [t.pid], foreignColumns: [parent.other] })],
    );
    expect(constraintOf(repointed, 'probe_fk')?.definition).not.toBe(
      constraintOf(withoutOnUpdate, 'probe_fk')?.definition,
    );
  });
});

describe('unique constraints', () => {
  const distinct = probe.table('uq_a', { a: text('a') }, (t) => [unique('probe_uq').on(t.a)]);
  const notDistinct = probe.table('uq_b', { a: text('a') }, (t) => [
    unique('probe_uq').on(t.a).nullsNotDistinct(),
  ]);

  it('projects NULLS NOT DISTINCT, so declaring it is not an empty diff', () => {
    const a = constraintOf(distinct, 'probe_uq')?.definition;
    const b = constraintOf(notDistinct, 'probe_uq')?.definition;
    expect(a).not.toBe(b);
    expect(b).toContain('NULLS NOT DISTINCT');
    expect(a).not.toContain('NULLS NOT DISTINCT');
  });
});

describe('generated columns', () => {
  const upper = probe.table('gen_a', {
    a: text('a'),
    g: text('g').generatedAlwaysAs(sql`upper(a)`),
  });
  const lower = probe.table('gen_b', {
    a: text('a'),
    g: text('g').generatedAlwaysAs(sql`lower(a)`),
  });
  const plain = probe.table('gen_c', { a: text('a'), g: text('g') });

  it('projects the generation expression, so changing it is not an empty diff', () => {
    const a = columnOf(upper, 'g')?.shape;
    const b = columnOf(lower, 'g')?.shape;
    expect(a).not.toBe(b);
    expect(a).toContain('upper(a)');
    expect(b).toContain('lower(a)');
  });

  it('distinguishes a generated column from an ordinary one', () => {
    expect(columnOf(upper, 'g')?.shape).not.toBe(columnOf(plain, 'g')?.shape);
    expect(columnOf(upper, 'g')?.shape).toContain('generated s');
    expect(columnOf(plain, 'g')?.shape).toContain('not generated');
  });
});

describe('index column detail', () => {
  const ascending = probe.table('idx_a', { a: text('a') }, (t) => [index('probe_idx').on(t.a)]);
  const descending = probe.table('idx_b', { a: text('a') }, (t) => [
    index('probe_idx').on(t.a.desc().nullsFirst()),
  ]);
  const descendingNullsLast = probe.table('idx_c', { a: text('a') }, (t) => [
    index('probe_idx').on(t.a.desc().nullsLast()),
  ]);
  const opclassed = probe.table('idx_d', { a: text('a') }, (t) => [
    index('probe_idx').on(t.a.op('text_pattern_ops')),
  ]);

  it('projects direction, so reversing a column is not an empty diff', () => {
    expect(indexOf(ascending, 'probe_idx')?.definition).not.toBe(
      indexOf(descending, 'probe_idx')?.definition,
    );
    expect(indexOf(descending, 'probe_idx')?.definition).toContain('a DESC');
  });

  it('projects NULL ordering only when it deviates, as PostgreSQL prints it', () => {
    // DESC implies NULLS FIRST and ASC implies NULLS LAST; PostgreSQL omits
    // both. Anything else is printed, and must be projected.
    expect(indexOf(ascending, 'probe_idx')?.definition).toContain('(a)');
    expect(indexOf(descending, 'probe_idx')?.definition).not.toContain('NULLS');
    expect(indexOf(descendingNullsLast, 'probe_idx')?.definition).toContain('DESC NULLS LAST');
    expect(indexOf(descendingNullsLast, 'probe_idx')?.definition).not.toBe(
      indexOf(descending, 'probe_idx')?.definition,
    );
  });

  it('projects the operator class, so changing it is not an empty diff', () => {
    expect(indexOf(opclassed, 'probe_idx')?.definition).toContain('text_pattern_ops');
    expect(indexOf(opclassed, 'probe_idx')?.definition).not.toBe(
      indexOf(ascending, 'probe_idx')?.definition,
    );
  });

  it('projects uniqueness, the method, storage parameters and ONLY', () => {
    const uniq = probe.table('idx_e', { a: text('a') }, (t) => [uniqueIndex('probe_idx').on(t.a)]);
    expect(indexOf(uniq, 'probe_idx')?.definition).toContain('CREATE UNIQUE INDEX');

    const hashed = probe.table('idx_f', { a: text('a') }, (t) => [
      index('probe_idx').using('hash', t.a),
    ]);
    expect(indexOf(hashed, 'probe_idx')?.definition).toContain('USING hash');

    const stored = probe.table('idx_g', { a: text('a') }, (t) => [
      index('probe_idx').on(t.a).with({ fillfactor: 70 }),
    ]);
    expect(indexOf(stored, 'probe_idx')?.definition).toContain("WITH (fillfactor='70')");

    // Drizzle sets `only` when an index is declared through `.using()`, so the
    // kernel declarations use `.on()`. Either way the flag is projected: `ON
    // ONLY` is what PostgreSQL prints for a partitioned parent's index, so it
    // is a persistent property and not a construction detail.
    expect(indexOf(hashed, 'probe_idx')?.definition).toContain('ON ONLY');
    expect(indexOf(ascending, 'probe_idx')?.definition).not.toContain('ON ONLY');
  });

  it('projects the predicate, so widening a partial index is not an empty diff', () => {
    const narrow = probe.table('idx_h', { a: text('a') }, (t) => [
      index('probe_idx')
        .on(t.a)
        .where(sql`a IS NOT NULL`),
    ]);
    expect(indexOf(narrow, 'probe_idx')?.definition).toContain('WHERE (a IS NOT NULL)');
    expect(indexOf(narrow, 'probe_idx')?.definition).not.toBe(
      indexOf(ascending, 'probe_idx')?.definition,
    );
  });
});

describe('construction-only options are refused, not ignored', () => {
  it('refuses `concurrently`, which has no persistent form', () => {
    // CREATE INDEX CONCURRENTLY leaves no trace in pg_get_indexdef, so nothing
    // downstream could verify it. Silently accepting it would make the
    // declaration read as covered when nothing checks it.
    const concurrent = probe.table('idx_conc', { a: text('a') }, (t) => [
      index('probe_idx').on(t.a).concurrently(),
    ]);
    expect(() => drizzleProjection([concurrent])).toThrow(/construction-only/);
  });
});

describe('columns, keys and checks still project', () => {
  const table = probe.table(
    'full',
    {
      id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
      at: timestamp('at', { withTimezone: true })
        .notNull()
        .default(sql`now()`),
      a: text('a').notNull(),
      b: text('b'),
    },
    (t) => [
      primaryKey({ name: 'probe_pk', columns: [t.a, t.b] }),
      check('probe_check', sql`(length(a) > 0)`),
    ],
  );

  it('projects identity, default, nullability, composite key and check', () => {
    const projection = drizzleProjection([table]);
    expect(columnOf(table, 'id')?.shape).toContain('identity a');
    expect(columnOf(table, 'at')?.shape).toContain('default now()');
    expect(columnOf(table, 'b')?.shape).toContain('| NULL |');
    expect(projection.constraints).toContainEqual(
      expect.objectContaining({ name: 'probe_pk', definition: 'PRIMARY KEY (a, b)' }),
    );
    expect(projection.constraints).toContainEqual(
      expect.objectContaining({ name: 'probe_check', definition: 'CHECK ((length(a) > 0))' }),
    );
  });
});

describe('SQL parameters are refused, never silently dropped', () => {
  it('refuses a parameterised check predicate', () => {
    // `sqlToQuery` returns `$1` placeholders and the values separately, so two
    // declarations differing only by a literal rendered identically and the
    // change was invisible. A schema declaration has no parameters: PostgreSQL
    // stores the literal.
    const parameterised = probe.table('param_a', { a: text('a') }, () => [
      check('probe_check', sql`a <> ${'forbidden'}`),
    ]);
    expect(() => drizzleProjection([parameterised])).toThrow(/parameterised/);
  });

  it('refuses a parameterised index predicate', () => {
    const parameterised = probe.table('param_b', { a: text('a') }, (t) => [
      index('probe_idx')
        .on(t.a)
        .where(sql`a <> ${'forbidden'}`),
    ]);
    expect(() => drizzleProjection([parameterised])).toThrow(/parameterised/);
  });

  it('refuses a parameterised generated expression', () => {
    const parameterised = probe.table('param_c', {
      a: text('a'),
      g: text('g').generatedAlwaysAs(sql`concat(a, ${'suffix'})`),
    });
    expect(() => drizzleProjection([parameterised])).toThrow(/parameterised/);
  });

  it('accepts the same predicate written as a literal', () => {
    const literal = probe.table('param_d', { a: text('a') }, () => [
      check('probe_check', sql`a <> 'forbidden'`),
    ]);
    expect(constraintOf(literal, 'probe_check')?.definition).toBe("CHECK (a <> 'forbidden')");
  });
});

describe('identity sequence metadata', () => {
  const plain = probe.table('id_a', {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity(),
  });
  const stepped = probe.table('id_b', {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity({ increment: 2 }),
  });
  const named = probe.table('id_c', {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity({ name: 'custom_seq' }),
  });
  const cycling = probe.table('id_d', {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity({ cycle: true }),
  });

  const sequenceOf = (table: ProjectableTable): string =>
    JSON.stringify(drizzleProjection([table]).identitySequences);

  it('projects the sequence, so its options are not an empty diff', () => {
    expect(sequenceOf(plain)).toContain('increment 1');
    expect(sequenceOf(stepped)).toContain('increment 2');
    expect(sequenceOf(plain)).not.toBe(sequenceOf(stepped));
  });

  it('projects the sequence name and the cycle setting', () => {
    expect(sequenceOf(named)).toContain('custom_seq');
    expect(sequenceOf(plain)).not.toBe(sequenceOf(named));
    expect(sequenceOf(cycling)).toContain('| cycle');
    expect(sequenceOf(plain)).toContain('no cycle');
  });

  it('defaults to PostgreSQL’s own start, bounds and cache', () => {
    expect(sequenceOf(plain)).toContain('start 1');
    expect(sequenceOf(plain)).toContain('min 1');
    expect(sequenceOf(plain)).toContain('max 9223372036854775807');
    expect(sequenceOf(plain)).toContain('cache 1');
  });
});

describe('column-level uniqueness', () => {
  const none = probe.table('cu_a', { a: text('a') });
  const unique = probe.table('cu_b', { a: text('a').unique() });
  const named = probe.table('cu_c', { a: text('a').unique('probe_named_unique') });
  const notDistinct = probe.table('cu_d', {
    a: text('a').unique('probe_named_unique', { nulls: 'not distinct' }),
  });

  it('projects a column-level unique as the constraint PostgreSQL records', () => {
    expect(drizzleProjection([none]).constraints).toHaveLength(0);
    expect(drizzleProjection([unique]).constraints).toContainEqual(
      expect.objectContaining({ kind: 'u', definition: 'UNIQUE (a)' }),
    );
  });

  it('projects the declared constraint name', () => {
    expect(constraintOf(named, 'probe_named_unique')?.definition).toBe('UNIQUE (a)');
    expect(constraintOf(unique, 'cu_b_a_unique')?.definition).toBe('UNIQUE (a)');
  });

  it('projects column-level NULLS NOT DISTINCT', () => {
    expect(constraintOf(notDistinct, 'probe_named_unique')?.definition).toBe(
      'UNIQUE NULLS NOT DISTINCT (a)',
    );
    expect(constraintOf(notDistinct, 'probe_named_unique')?.definition).not.toBe(
      constraintOf(named, 'probe_named_unique')?.definition,
    );
  });
});

describe('row level security and policies', () => {
  const off = probe.table('rls_a', { a: text('a'), hotelId: text('hotel_id') });
  const on = probe.table('rls_b', { a: text('a'), hotelId: text('hotel_id') }).enableRLS();
  const policied = probe
    .table('rls_c', { a: text('a'), hotelId: text('hotel_id') }, () => [
      pgPolicy('probe_policy', {
        using: sql`(hotel_id = platform.current_hotel_id())`,
        withCheck: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ])
    .enableRLS();
  const widened = probe
    .table('rls_d', { a: text('a'), hotelId: text('hotel_id') }, () => [
      pgPolicy('probe_policy', { using: sql`(true)` }),
    ])
    .enableRLS();
  const restrictive = probe
    .table('rls_e', { a: text('a'), hotelId: text('hotel_id') }, () => [
      pgPolicy('probe_policy', {
        as: 'restrictive',
        for: 'select',
        to: 'prsystem_api',
        using: sql`(hotel_id = platform.current_hotel_id())`,
      }),
    ])
    .enableRLS();

  it('projects RLS enablement, so turning it off is not an empty diff', () => {
    expect(drizzleProjection([off]).rls).toEqual([]);
    expect(drizzleProjection([on]).rls).toEqual([
      { schema: 'extraction_probe', table: 'rls_b', enabled: true },
    ]);
  });

  it('projects the policy predicate, so weakening it is not an empty diff', () => {
    const strict = drizzleProjection([policied]).policies[0]?.using;
    const weak = drizzleProjection([widened]).policies[0]?.using;
    expect(strict).toBe('(hotel_id = platform.current_hotel_id())');
    expect(weak).toBe('(true)');
    expect(strict).not.toBe(weak);
  });

  it('projects permissiveness, command and roles, with PostgreSQL defaults', () => {
    const permissive = drizzleProjection([policied]).policies[0];
    expect([permissive?.as, permissive?.command, permissive?.to]).toEqual([
      'PERMISSIVE',
      'ALL',
      ['public'],
    ]);
    const strict = drizzleProjection([restrictive]).policies[0];
    expect([strict?.as, strict?.command, strict?.to]).toEqual([
      'RESTRICTIVE',
      'SELECT',
      ['prsystem_api'],
    ]);
  });

  it('projects WITH CHECK separately from USING', () => {
    expect(drizzleProjection([policied]).policies[0]?.withCheck).not.toBeNull();
    expect(drizzleProjection([widened]).policies[0]?.withCheck).toBeNull();
  });
});

/**
 * Column defaults, rendered through the same refusal every other fragment uses.
 *
 * `column.default` went straight to `sqlToQuery(...).sql` rather than through
 * `render()`, so a parameterised default projected as `default $1` — and two
 * genuinely different defaults projected identically. A default is a persistent
 * property PostgreSQL stores as literal text; a placeholder makes a value change
 * invisible in exactly the way the check, generated-expression and predicate
 * refusals already prevent.
 */
describe('parameterised column defaults', () => {
  const one = probe.table('default_a', {
    id: integer('id').primaryKey(),
    n: integer('n').default(sql`${1}`),
  });
  const two = probe.table('default_b', {
    id: integer('id').primaryKey(),
    n: integer('n').default(sql`${2}`),
  });
  const literal = probe.table('default_c', {
    id: integer('id').primaryKey(),
    n: integer('n').default(sql`1`),
  });

  it('refuses a parameterised default rather than projecting a placeholder', () => {
    expect(() => drizzleProjection([one])).toThrow(/parameterised/);
    expect(() => drizzleProjection([two])).toThrow(/parameterised/);
  });

  it('accepts the equivalent literal default', () => {
    expect(columnOf(literal, 'n')?.shape).toContain('default 1');
  });
});

/**
 * Policy targets named by `pgRole`.
 *
 * `String(pgRole('role_a'))` is `[object Object]`, so two policies granted to
 * genuinely different roles projected the same text and a change of grantee was
 * an empty diff.
 */
describe('policy role targets', () => {
  const roleA = pgRole('probe_role_a');
  const roleB = pgRole('probe_role_b');

  const toA = probe
    .table('role_a', { a: text('a') }, () => [
      pgPolicy('probe_policy', { for: 'select', to: roleA, using: sql`(true)` }),
    ])
    .enableRLS();
  const toB = probe
    .table('role_b', { a: text('a') }, () => [
      pgPolicy('probe_policy', { for: 'select', to: roleB, using: sql`(true)` }),
    ])
    .enableRLS();
  const toBoth = probe
    .table('role_c', { a: text('a') }, () => [
      pgPolicy('probe_policy', { for: 'select', to: [roleA, roleB], using: sql`(true)` }),
    ])
    .enableRLS();
  const toMixed = probe
    .table('role_d', { a: text('a') }, () => [
      pgPolicy('probe_policy', { for: 'select', to: [roleA, 'public'], using: sql`(true)` }),
    ])
    .enableRLS();

  it('renders a single role target by name', () => {
    expect(drizzleProjection([toA]).policies[0]?.to).toEqual(['probe_role_a']);
  });

  it('tells two different role targets apart', () => {
    const a = drizzleProjection([toA]).policies[0]?.to;
    const b = drizzleProjection([toB]).policies[0]?.to;
    expect(a).not.toEqual(b);
    expect(b).toEqual(['probe_role_b']);
  });

  it('renders an array target as its role names', () => {
    expect(drizzleProjection([toBoth]).policies[0]?.to).toEqual(['probe_role_a', 'probe_role_b']);
    expect(drizzleProjection([toMixed]).policies[0]?.to).toEqual(['probe_role_a', 'public']);
  });

  it('refuses a target representation it cannot name', () => {
    const opaque = probe
      .table('role_e', { a: text('a') }, () => [
        pgPolicy('probe_policy', {
          for: 'select',
          to: { notARole: true } as unknown as string,
          using: sql`(true)`,
        }),
      ])
      .enableRLS();
    expect(() => drizzleProjection([opaque])).toThrow(/policy target/);
  });
});

/**
 * PostgreSQL enum types.
 *
 * `enumValues` was classified as non-persistent. For a column declared from a
 * `pgEnum` it is nothing of the sort: the labels and their order are stored in
 * `pg_enum`, they decide which values the column accepts and how it sorts, and
 * two same-named declarations with different labels projected identically. The
 * TypeScript-only `text({ enum })` hint really is non-persistent, and the two
 * have to be told apart rather than lumped together.
 */
describe('PostgreSQL enum types', () => {
  const moodTwo = probe.enum('probe_mood', ['sad', 'happy']);
  const moodThree = probe.enum('probe_mood', ['sad', 'ok', 'happy']);
  const moodReordered = probe.enum('probe_mood', ['happy', 'sad']);

  const withTwo = probe.table('enum_a', { id: integer('id').primaryKey(), m: moodTwo('m') });
  const withThree = probe.table('enum_b', { id: integer('id').primaryKey(), m: moodThree('m') });
  const reordered = probe.table('enum_c', {
    id: integer('id').primaryKey(),
    m: moodReordered('m'),
  });
  const textHint = probe.table('enum_d', {
    id: integer('id').primaryKey(),
    m: text('m', { enum: ['sad', 'happy'] }),
  });

  it('projects the enum type with its ordered labels', () => {
    expect(drizzleProjection([withTwo]).enums).toEqual([
      { schema: 'extraction_probe', name: 'probe_mood', labels: ['sad', 'happy'] },
    ]);
  });

  it('tells an added label apart', () => {
    expect(drizzleProjection([withTwo]).enums).not.toEqual(drizzleProjection([withThree]).enums);
  });

  it('tells a reordered label list apart', () => {
    expect(drizzleProjection([withTwo]).enums).not.toEqual(drizzleProjection([reordered]).enums);
  });

  it('does not treat a TypeScript-only text enum hint as a PostgreSQL type', () => {
    expect(drizzleProjection([textHint]).enums).toEqual([]);
  });

  it('reports each enum type once however many columns use it', () => {
    const both = probe.table('enum_e', {
      id: integer('id').primaryKey(),
      a: moodTwo('a'),
      b: moodTwo('b'),
    });
    expect(drizzleProjection([both]).enums).toHaveLength(1);
  });
});

/**
 * A declared table with no columns.
 *
 * `diffDeclarations` derived its table inventory from the projected columns, so
 * a table with none was absent from it — and every reverse comparison is scoped
 * by that inventory. Removing the last column from a declared table therefore
 * produced an empty difference: the snapshot's columns, keys and indexes for it
 * were all filtered out as "not a declared table".
 */
describe('a declared table with no columns', () => {
  const empty = probe.table('empty_a', {});

  const snapshot = {
    columns: [
      {
        schema: 'extraction_probe',
        table: 'empty_a',
        column: 'gone',
        shape: 'integer | NOT NULL | no default | no identity | not generated',
      },
    ],
    constraints: [],
    indexes: [],
    identitySequences: [],
    rls: [],
    policies: [],
    enums: [],
  };

  it('carries the table in the declared inventory', () => {
    expect(drizzleProjection([empty]).tables).toEqual([
      { schema: 'extraction_probe', table: 'empty_a' },
    ]);
  });

  it('reports the snapshot column that the declaration no longer has', () => {
    const differences = diffDeclarations(drizzleProjection([empty]), snapshot);
    expect(differences).toHaveLength(1);
    expect(differences[0]?.subject).toBe('extraction_probe.empty_a.gone');
  });

  it('still reports a declared column the snapshot lacks', () => {
    const populated = probe.table('empty_a', { gone: integer('gone').notNull() });
    expect(diffDeclarations(drizzleProjection([populated]), snapshot)).toEqual([]);
  });
});

/**
 * Enum labels, kept as an ordered structure rather than joined text.
 *
 * `labels: values.join(', ')` is not injective: `['a, b']` and `['a', 'b']` are
 * different PostgreSQL types — one label containing a comma against two labels —
 * and both rendered `a, b`. A label is arbitrary text, so any delimiter can
 * appear inside one.
 */
describe('enum label serialisation is lossless', () => {
  const oneCommaLabel = probe.table('label_a', { m: probe.enum('probe_labels', ['a, b'])('m') });
  const twoLabels = probe.table('label_b', { m: probe.enum('probe_labels', ['a', 'b'])('m') });
  const joinedLabel = probe.table('label_c', { m: probe.enum('probe_labels', ['ab'])('m') });
  const quoted = probe.table('label_d', {
    m: probe.enum('probe_labels', ['a"b', "c'd"])('m'),
  });
  const unicode = probe.table('label_e', {
    m: probe.enum('probe_labels', ['ᠮᠣᠩᠭᠣᠯ', 'улс'])('m'),
  });
  const reordered = probe.table('label_f', { m: probe.enum('probe_labels', ['b', 'a'])('m') });

  const labelsOf = (table: ProjectableTable) => drizzleProjection([table]).enums[0]?.labels;

  it('keeps the labels as an ordered list', () => {
    expect(labelsOf(twoLabels)).toEqual(['a', 'b']);
  });

  it('tells one comma-containing label from two labels', () => {
    expect(labelsOf(oneCommaLabel)).not.toEqual(labelsOf(twoLabels));
    expect(labelsOf(oneCommaLabel)).toEqual(['a, b']);
  });

  it('tells a label boundary apart from a concatenation', () => {
    expect(labelsOf(joinedLabel)).not.toEqual(labelsOf(twoLabels));
  });

  it('preserves quotes and Unicode exactly', () => {
    expect(labelsOf(quoted)).toEqual(['a"b', "c'd"]);
    expect(labelsOf(unicode)).toEqual(['ᠮᠣᠩᠭᠣᠯ', 'улс']);
  });

  it('preserves order', () => {
    expect(labelsOf(reordered)).toEqual(['b', 'a']);
    expect(labelsOf(reordered)).not.toEqual(labelsOf(twoLabels));
  });
});

/**
 * Policy targets, kept as an ordered list of exact role names.
 *
 * `to.join(', ')` collapses one role named `a, b` and the two roles `a` and `b`
 * into the same text, and those grant different things. A role name is an
 * identifier that may contain any character, so no delimiter is safe.
 */
describe('policy target serialisation is lossless', () => {
  const commaRole = pgRole('probe_x, probe_y');
  const roleX = pgRole('probe_x');
  const roleY = pgRole('probe_y');

  const policyTo = (to: unknown) =>
    drizzleProjection([
      probe
        .table('target_probe', { a: text('a') }, () => [
          pgPolicy('probe_policy', { for: 'select', to: to as string, using: sql`(true)` }),
        ])
        .enableRLS(),
    ]).policies[0];

  it('keeps a single target as a one-element list', () => {
    expect(policyTo(roleX)?.to).toEqual(['probe_x']);
  });

  it('tells one comma-containing role from two roles', () => {
    expect(policyTo(commaRole)?.to).toEqual(['probe_x, probe_y']);
    expect(policyTo([roleX, roleY])?.to).toEqual(['probe_x', 'probe_y']);
    expect(policyTo(commaRole)?.to).not.toEqual(policyTo([roleX, roleY])?.to);
  });

  it('accepts a plain role name', () => {
    expect(policyTo('prsystem_api')?.to).toEqual(['prsystem_api']);
  });

  it('defaults to public when no target is declared', () => {
    const table = probe
      .table('target_default', { a: text('a') }, () => [
        pgPolicy('probe_policy', { using: sql`(true)` }),
      ])
      .enableRLS();
    expect(drizzleProjection([table]).policies[0]?.to).toEqual(['public']);
  });

  it('refuses an object that merely looks like a role', () => {
    // Structural acceptance took any `{ name: string }`. Drizzle's own identity
    // check is the only thing that says this is a role rather than a shape.
    expect(() => policyTo({ name: 'not_a_pg_role' })).toThrow(/policy target/);
    expect(() => policyTo([roleX, { name: 'not_a_pg_role' }])).toThrow(/policy target/);
  });
});

/**
 * Enums declared but not used by any column.
 *
 * Discovery ran over table columns only, so an exported `pgEnum` nothing
 * references projected nothing at all — while `CREATE TYPE` still puts it in the
 * database and Drizzle Kit still loads it from the schema module. The
 * declaration and the database disagreed and the diff was empty.
 */
describe('standalone enum declarations', () => {
  const standalone = probe.enum('probe_standalone', ['x', 'y']);
  const referenced = probe.enum('probe_referenced', ['p', 'q']);
  const table = probe.table('enum_holder', {
    id: integer('id').primaryKey(),
    m: referenced('m'),
  });

  it('projects an enum no column references', () => {
    expect(drizzleProjection([], [standalone]).enums).toEqual([
      { schema: 'extraction_probe', name: 'probe_standalone', labels: ['x', 'y'] },
    ]);
  });

  it('projects referenced and standalone enums together, each once', () => {
    const names = drizzleProjection([table], [standalone, referenced]).enums.map(
      (e) => `${e.schema}.${e.name}`,
    );
    expect(names.sort()).toEqual([
      'extraction_probe.probe_referenced',
      'extraction_probe.probe_standalone',
    ]);
  });

  it('refuses two conflicting declarations of the same qualified enum', () => {
    const other = probe.enum('probe_standalone', ['x', 'z']);
    expect(() => drizzleProjection([], [standalone, other])).toThrow(/declared twice/);
  });

  it('accepts the same enum declared twice with identical labels', () => {
    expect(drizzleProjection([table], [referenced, referenced]).enums).toHaveLength(1);
  });

  it('reports every exported enum of a module', () => {
    const module = { mood: standalone, other: referenced, table, count: 3 };
    expect(
      exportedEnums(module)
        .map((e) => e.enumName)
        .sort(),
    ).toEqual(['probe_referenced', 'probe_standalone']);
  });
});

/**
 * The same qualified table declared twice.
 *
 * The projection appended each declaration's columns, so two partial
 * declarations of `platform.job_run` were unioned into one apparent table that
 * matched the snapshot while neither declaration described it. Two declarations
 * of one table are a contradiction, not a merge.
 */
describe('duplicate qualified table declarations', () => {
  const partA = probe.table('dup', { a: integer('a') });
  const partB = probe.table('dup', { b: integer('b') });
  const conflicting = probe.table('dup', { a: text('a') });

  it('refuses two partial declarations of the same qualified table', () => {
    expect(() => drizzleProjection([partA, partB])).toThrow(/declared twice/);
  });

  it('refuses two conflicting declarations of the same qualified table', () => {
    expect(() => drizzleProjection([partA, conflicting])).toThrow(/declared twice/);
  });

  it('refuses the same table object listed twice', () => {
    expect(() => drizzleProjection([partA, partA])).toThrow(/declared twice/);
  });

  it('leaves a foreign key to a table outside the list alone', () => {
    // The positive control: `parent` is referenced but not projected, which is
    // the ordinary case and must keep working.
    const child = probe.table(
      'dup_child',
      { id: integer('id').primaryKey(), pid: integer('pid') },
      (t) => [foreignKey({ name: 'dup_fk', columns: [t.pid], foreignColumns: [parent.id] })],
    );
    expect(drizzleProjection([child]).constraints.some((c) => c.name === 'dup_fk')).toBe(true);
  });
});

/**
 * Compound keys that a name can forge.
 *
 * Every comparison keyed on `${table}.${name}` is ambiguous, because a schema,
 * table, column, constraint, index or policy name may itself contain a dot.
 * Two genuinely different objects then produce the same key, one silently
 * replaces the other while the maps are built, and a changed predicate on the
 * loser is reported as no difference at all.
 */
describe('compound keys are injective', () => {
  const dotted = pgSchema('probe.dotted');

  const snapshotOf = (projection: ReturnType<typeof drizzleProjection>) => ({
    columns: projection.columns,
    constraints: projection.constraints,
    indexes: projection.indexes,
    identitySequences: projection.identitySequences,
    rls: projection.rls.map((entry) => ({ ...entry, forced: true })),
    policies: projection.policies,
    enums: projection.enums,
  });

  it('tells two policies whose dotted keys collide apart', () => {
    const outer = dotted
      .table('a.b', { hotelId: text('hotel_id') }, () => [
        pgPolicy('c', { for: 'select', using: sql`(true)` }),
      ])
      .enableRLS();
    const inner = dotted
      .table('a', { hotelId: text('hotel_id') }, () => [
        pgPolicy('b.c', { for: 'select', using: sql`(false)` }),
      ])
      .enableRLS();

    const projection = drizzleProjection([outer, inner]);
    expect(projection.policies).toHaveLength(2);

    // The snapshot agrees, then one predicate is weakened. Exactly one
    // difference must be reported, and it must name the policy that changed.
    const snapshot = snapshotOf(projection);
    expect(diffDeclarations(projection, snapshot)).toEqual([]);

    const weakened = {
      ...snapshot,
      policies: snapshot.policies.map((policy) =>
        policy.name === 'c' ? { ...policy, using: '(1 = 1)' } : policy,
      ),
    };
    const differences = diffDeclarations(projection, weakened);
    expect(differences).toHaveLength(1);
    expect(differences[0]?.kind).toBe('declaration-policy');
  });

  it('tells two columns whose dotted keys collide apart', () => {
    const outer = dotted.table('x.y', { z: text('z') });
    const inner = dotted.table('x', { 'y.z': text('y.z') });
    const projection = drizzleProjection([outer, inner]);
    expect(projection.columns).toHaveLength(2);

    const snapshot = snapshotOf(projection);
    expect(diffDeclarations(projection, snapshot)).toEqual([]);

    const changed = {
      ...snapshot,
      columns: snapshot.columns.map((column) =>
        column.column === 'z'
          ? { ...column, shape: column.shape.replace('text', 'integer') }
          : column,
      ),
    };
    expect(diffDeclarations(projection, changed)).toHaveLength(1);
  });

  it('tells two constraints whose dotted keys collide apart', () => {
    const outer = dotted.table('p.q', { a: integer('a') }, () => [check('r', sql`(a > 0)`)]);
    const inner = dotted.table('p', { a: integer('a') }, () => [check('q.r', sql`(a > 1)`)]);
    const projection = drizzleProjection([outer, inner]);
    expect(projection.constraints.filter((c) => c.kind === 'c')).toHaveLength(2);

    const snapshot = snapshotOf(projection);
    expect(diffDeclarations(projection, snapshot)).toEqual([]);

    const weakened = {
      ...snapshot,
      constraints: snapshot.constraints.map((constraint) =>
        constraint.name === 'r' ? { ...constraint, definition: 'CHECK ((a > 5))' } : constraint,
      ),
    };
    expect(diffDeclarations(projection, weakened)).toHaveLength(1);
  });

  it('tells two indexes whose dotted keys collide apart', () => {
    const outer = dotted.table('i.j', { a: integer('a') }, (t) => [index('k').on(t.a)]);
    const inner = dotted.table('i', { a: integer('a') }, (t) => [index('j.k').on(t.a)]);
    const projection = drizzleProjection([outer, inner]);
    expect(projection.indexes).toHaveLength(2);

    const snapshot = snapshotOf(projection);
    expect(diffDeclarations(projection, snapshot)).toEqual([]);

    const changed = {
      ...snapshot,
      indexes: snapshot.indexes.map((entry) =>
        entry.name === 'k' ? { ...entry, definition: `${entry.definition} WHERE (a > 0)` } : entry,
      ),
    };
    expect(diffDeclarations(projection, changed)).toHaveLength(1);
  });

  it('tells two enums whose dotted qualified names collide apart', () => {
    const outerSchema = pgSchema('e.f');
    const innerSchema = pgSchema('e');
    const outer = outerSchema.enum('g', ['one']);
    const inner = innerSchema.enum('f.g', ['two']);
    const projection = drizzleProjection([], [outer, inner]);
    expect(projection.enums).toHaveLength(2);

    const snapshot = snapshotOf(projection);
    expect(diffDeclarations(projection, snapshot)).toEqual([]);
  });
});

/**
 * The whole top-level export surface, not one hand-kept list.
 *
 * Drizzle Kit loads what the schema module exports. Anything it would create
 * that this projection does not know about is a persistent object the gate
 * cannot see: an exported table missing from `DECLARED_TABLES`, an exported enum
 * registered under the same name but different labels, a standalone sequence, or
 * an entity kind nobody classified.
 */
describe('the declared inventory is bound to the module exports', () => {
  const inventorySchema = pgSchema('inventory_probe');
  const table = inventorySchema.table('t', { id: integer('id').primaryKey() });
  const mood = inventorySchema.enum('mood', ['sad', 'happy']);

  it('accepts a module whose exports are all registered', () => {
    expect(() =>
      assertDeclaredInventory({ inventorySchema, table, mood }, { tables: [table], enums: [mood] }),
    ).not.toThrow();
  });

  it('refuses an exported table that the registry omits', () => {
    expect(() =>
      assertDeclaredInventory({ inventorySchema, table }, { tables: [], enums: [] }),
    ).toThrow(/inventory_probe\.t/);
  });

  it('refuses a registered table that is not exported', () => {
    const other = inventorySchema.table('u', { id: integer('id').primaryKey() });
    expect(() =>
      assertDeclaredInventory({ inventorySchema, table }, { tables: [table, other], enums: [] }),
    ).toThrow(/inventory_probe\.u/);
  });

  it('refuses a same-name enum registered in place of the exported one', () => {
    // Same qualified name, different labels — and a different object. Comparing
    // flattened names alone accepted this.
    const impostor = inventorySchema.enum('mood', ['sad', 'furious']);
    expect(() =>
      assertDeclaredInventory(
        { inventorySchema, table, mood },
        { tables: [table], enums: [impostor] },
      ),
    ).toThrow(/inventory_probe\.mood/);
  });

  it('refuses an exported standalone sequence', () => {
    const sequence = inventorySchema.sequence('s');
    expect(() =>
      assertDeclaredInventory({ inventorySchema, table, sequence }, { tables: [table], enums: [] }),
    ).toThrow(/PgSequence/);
  });

  it('refuses an exported entity kind nobody classified', () => {
    const role = pgRole('inventory_probe_role');
    expect(() =>
      assertDeclaredInventory({ inventorySchema, table, role }, { tables: [table], enums: [] }),
    ).toThrow(/PgRole/);
  });

  it('classifies exported schemas explicitly', () => {
    expect(classifyExports({ inventorySchema, table, mood }).schemas).toEqual(['inventory_probe']);
  });

  it('refuses two registered tables with the same qualified name', () => {
    const twin = inventorySchema.table('t', { id: integer('id').primaryKey() });
    expect(() =>
      assertDeclaredInventory(
        { inventorySchema, table, twin },
        { tables: [table, twin], enums: [] },
      ),
    ).toThrow(/declared twice/);
  });
});
