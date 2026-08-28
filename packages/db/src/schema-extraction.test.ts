import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { drizzleProjection } from './schema-projection';

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
function constraintOf(table: Parameters<typeof drizzleProjection>[0][number], name: string) {
  return drizzleProjection([table]).constraints.find((entry) => entry.name === name);
}

function indexOf(table: Parameters<typeof drizzleProjection>[0][number], name: string) {
  return drizzleProjection([table]).indexes.find((entry) => entry.name === name);
}

function columnOf(table: Parameters<typeof drizzleProjection>[0][number], name: string) {
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
