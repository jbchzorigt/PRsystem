import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgPolicy,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { drizzleProjection } from './schema-projection';
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
      { table: 'extraction_probe.rls_b', enabled: true },
    ]);
  });

  it('projects the policy predicate, so weakening it is not an empty diff', () => {
    const strict = drizzleProjection([policied]).policies[0]?.definition;
    const weak = drizzleProjection([widened]).policies[0]?.definition;
    expect(strict).toContain('USING ((hotel_id = platform.current_hotel_id()))');
    expect(weak).toContain('USING ((true))');
    expect(strict).not.toBe(weak);
  });

  it('projects permissiveness, command and roles, with PostgreSQL defaults', () => {
    expect(drizzleProjection([policied]).policies[0]?.definition).toContain(
      'AS PERMISSIVE FOR ALL TO public',
    );
    expect(drizzleProjection([restrictive]).policies[0]?.definition).toContain(
      'AS RESTRICTIVE FOR SELECT TO prsystem_api',
    );
  });

  it('projects WITH CHECK separately from USING', () => {
    expect(drizzleProjection([policied]).policies[0]?.definition).toContain('WITH CHECK');
    expect(drizzleProjection([widened]).policies[0]?.definition).not.toContain('WITH CHECK');
  });
});
