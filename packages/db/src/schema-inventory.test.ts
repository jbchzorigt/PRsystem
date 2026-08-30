import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableConfig, integer, pgSchema, text } from 'drizzle-orm/pg-core';
import * as schemaModule from './schema';
import { DECLARED_ENUMS, DECLARED_TABLES } from './schema';
import {
  assertDeclaredInventory,
  compareDeclarationToSnapshot,
  drizzleProjection,
  exportedEnums,
} from './schema-projection';

/**
 * A version-pinned inventory of what the extractor reads.
 *
 * Every property Drizzle exposes on a table configuration, a column or an index
 * is either projected, explicitly rejected, or recorded here as non-persistent.
 * A property nobody classified is the failure mode this exists to prevent:
 * `onUpdate`, `NULLS NOT DISTINCT`, the generated expression, index ordering,
 * the identity sequence, column-level uniqueness and RLS were each silently
 * ignored while every test stayed green.
 *
 * Pinned to a version because the inventory is only meaningful against a known
 * surface: an upgrade that adds a property must fail here and be classified.
 */

const PINNED_DRIZZLE_VERSION = '0.45.2';

/** Table-configuration keys, and how each is handled. */
const TABLE_CONFIG_INVENTORY: Readonly<Record<string, 'projected' | 'non-persistent'>> = {
  columns: 'projected',
  indexes: 'projected',
  foreignKeys: 'projected',
  checks: 'projected',
  primaryKeys: 'projected',
  uniqueConstraints: 'projected',
  policies: 'projected',
  enableRLS: 'projected',
  // Identity of the table itself, not a property of it.
  name: 'non-persistent',
  schema: 'non-persistent',
};

/** Column keys that carry persistent schema meaning, and how each is handled. */
const COLUMN_INVENTORY: Readonly<Record<string, 'projected' | 'non-persistent' | 'rejected'>> = {
  name: 'projected',
  notNull: 'projected',
  default: 'projected',
  primary: 'projected',
  isUnique: 'projected',
  uniqueName: 'projected',
  uniqueType: 'projected',
  generated: 'projected',
  generatedIdentity: 'projected',
  // Persistent, and projected through `getSQLType()`, which renders them into
  // the SQL type the shape compares — `timestamp with time zone`, not two
  // separate fields.
  precision: 'projected',
  withTimezone: 'projected',
  // Drizzle-side only: how a value is read back into JavaScript, not how
  // PostgreSQL stores it.
  dataType: 'non-persistent',
  columnType: 'non-persistent',
  // The PostgreSQL enum type behind a `pgEnum` column: its name and its ordered
  // labels are stored in `pg_type`/`pg_enum` and decide which values the column
  // accepts and how it sorts.
  enum: 'projected',
  // The label list as Drizzle exposes it on *any* column, including a
  // `text({ enum })` column, where it is a TypeScript narrowing and leaves no
  // trace in the catalogue. The persistent form is read from `enum` above, which
  // only a `pgEnum` column carries — which is how the two are told apart.
  enumValues: 'non-persistent',
  defaultFn: 'non-persistent',
  onUpdateFn: 'non-persistent',
  hasDefault: 'non-persistent',
  config: 'non-persistent',
  table: 'non-persistent',
  keyAsName: 'non-persistent',
  mapFrom: 'non-persistent',
  mapTo: 'non-persistent',
  mapToDriverValue: 'non-persistent',
};

/** Index-configuration keys. */
const INDEX_INVENTORY: Readonly<Record<string, 'projected' | 'rejected' | 'non-persistent'>> = {
  name: 'projected',
  unique: 'projected',
  only: 'projected',
  method: 'projected',
  with: 'projected',
  where: 'projected',
  columns: 'projected',
  // A back-reference to the table the index is declared on, not a property of
  // the index.
  table: 'non-persistent',
  // Construction-only: CREATE INDEX CONCURRENTLY leaves no trace in
  // pg_get_indexdef, so nothing downstream could verify it.
  concurrently: 'rejected',
};

describe('extraction property inventory', () => {
  it('is pinned to the installed Drizzle version', () => {
    const lock = readFileSync(resolve(__dirname, '..', '..', '..', 'pnpm-lock.yaml'), 'utf8');
    expect(lock).toContain(`drizzle-orm@${PINNED_DRIZZLE_VERSION}`);
  });

  it('classifies every table-configuration key the shipped schema exposes', () => {
    const seen = new Set<string>();
    for (const table of DECLARED_TABLES) {
      for (const key of Object.keys(getTableConfig(table))) seen.add(key);
    }
    const unclassified = [...seen].filter((key) => !(key in TABLE_CONFIG_INVENTORY)).sort();
    expect(unclassified).toEqual([]);
  });

  it('classifies every column key that could carry schema meaning', () => {
    const seen = new Set<string>();
    for (const table of DECLARED_TABLES) {
      for (const column of getTableConfig(table).columns) {
        for (const key of Object.keys(column)) seen.add(key);
      }
    }
    const unclassified = [...seen]
      .filter((key) => !key.startsWith('_'))
      .filter((key) => !(key in COLUMN_INVENTORY))
      .sort();
    expect(unclassified).toEqual([]);
  });

  it('classifies every index-configuration key', () => {
    const seen = new Set<string>();
    for (const table of DECLARED_TABLES) {
      for (const declared of getTableConfig(table).indexes) {
        for (const key of Object.keys(declared.config)) seen.add(key);
      }
    }
    const unclassified = [...seen].filter((key) => !(key in INDEX_INVENTORY)).sort();
    expect(unclassified).toEqual([]);
  });

  it('classifies every key a pgEnum column adds', () => {
    // The shipped schema declares no enum type, so scanning it alone would never
    // reach the keys a `pgEnum` column carries — and `enum` was exactly the key
    // whose absence let the persistent half of `enumValues` go unclassified.
    const probe = pgSchema('inventory_probe');
    const mood = probe.enum('inventory_mood', ['sad', 'happy']);
    const table = probe.table('t', {
      id: integer('id').primaryKey(),
      m: mood('m'),
      hint: text('hint', { enum: ['a', 'b'] }),
    });
    const seen = new Set<string>();
    for (const column of getTableConfig(table).columns) {
      for (const key of Object.keys(column)) seen.add(key);
    }
    expect(seen.has('enum')).toBe(true);
    const unclassified = [...seen]
      .filter((key) => !key.startsWith('_'))
      .filter((key) => !(key in COLUMN_INVENTORY))
      .sort();
    expect(unclassified).toEqual([]);
    // And the classification is honest in both directions.
    expect(drizzleProjection([table]).enums).toEqual([
      { schema: 'inventory_probe', name: 'inventory_mood', labels: ['sad', 'happy'] },
    ]);
  });

  it('registers every persistent entity the schema module exports', () => {
    // The registries are only a contract if something holds them to the module.
    // Drizzle Kit creates what the module exports, so an unregistered table, a
    // same-named enum registered in place of the exported one, a standalone
    // sequence or an entity kind nobody classified is a persistent object the
    // gate cannot see. Binding is by object identity.
    const module = schemaModule as unknown as Record<string, unknown>;
    expect(() => assertDeclaredInventory(module)).not.toThrow();
    const inventory = assertDeclaredInventory(module);
    expect(inventory.tables).toHaveLength(DECLARED_TABLES.length);
    expect(inventory.enums).toHaveLength(DECLARED_ENUMS.length);
    expect([...inventory.schemas].sort()).toEqual(['audit', 'platform', 'police_audit']);
    // Non-vacuous: the same helper reads enums off a module that has one.
    expect(exportedEnums(module)).toEqual([...DECLARED_ENUMS]);
  });

  it('projects something for every key classified as projected', () => {
    // Guards against an entry being marked "projected" without the extractor
    // reading it — the inventory would then be a comment rather than a check.
    const projection = drizzleProjection();
    expect(projection.columns.length).toBeGreaterThan(0);
    expect(projection.constraints.some((c) => c.kind === 'f')).toBe(true);
    expect(projection.constraints.some((c) => c.kind === 'c')).toBe(true);
    expect(projection.constraints.some((c) => c.kind === 'u')).toBe(true);
    expect(projection.constraints.some((c) => c.kind === 'p')).toBe(true);
    expect(projection.indexes.length).toBeGreaterThan(0);
    expect(projection.identitySequences.length).toBeGreaterThan(0);
    expect(projection.rls.length).toBeGreaterThan(0);
    expect(projection.policies.length).toBeGreaterThan(0);
    expect(projection.tables).toEqual(
      DECLARED_TABLES.map((table) => {
        const config = getTableConfig(table);
        return { schema: config.schema ?? 'public', table: config.name };
      }),
    );
  });

  it('agrees with the canonical snapshot as shipped', () => {
    expect(compareDeclarationToSnapshot()).toEqual([]);
  });
});
