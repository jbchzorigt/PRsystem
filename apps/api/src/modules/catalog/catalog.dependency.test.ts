import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEPENDENCY_SOURCES } from './contracts/dependency-sources';
import type { CatalogHarness } from './test-support/catalog-harness';
import { createCatalogHarness } from './test-support/catalog-harness';

/**
 * The dependency registry against the live schema.
 *
 * A Phase 06 entry must point at a relation and column that exist now. An entry
 * owned by a later phase must **not** exist yet — and when that phase lands, this
 * test is what tells it to either use the named relation and column or update
 * the entry in the same change. Either way the registry can never quietly point
 * at nothing.
 */

let env: CatalogHarness;

beforeAll(async () => {
  env = await createCatalogHarness('catalog_dependency');
}, 120000);

afterAll(async () => {
  await env.close();
}, 30000);

async function columnExists(relation: string, column: string): Promise<boolean> {
  const [schema, table] = relation.split('.');
  const result = await env.admin.query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
     ) AS present`,
    [schema, table, column],
  );
  return result.rows[0]?.present === true;
}

async function relationExists(relation: string): Promise<boolean> {
  const result = await env.admin.query<{ present: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS present`,
    [relation],
  );
  return result.rows[0]?.present === true;
}

describe('the registry and the schema agree', () => {
  it('every Phase 06 source names a relation, a column and a hotel_id that exist', async () => {
    const own = DEPENDENCY_SOURCES.filter((source) => source.owningPhase === '06');
    expect(own.length).toBeGreaterThanOrEqual(4);
    for (const source of own) {
      expect({ id: source.id, relation: await relationExists(source.relation) }).toEqual({
        id: source.id,
        relation: true,
      });
      expect({ id: source.id, column: await columnExists(source.relation, source.column) }).toEqual(
        {
          id: source.id,
          column: true,
        },
      );
      expect(await columnExists(source.relation, 'hotel_id')).toBe(true);
    }
  });

  it('every source owned by a later phase is not yet provisioned — or has been, with its column', async () => {
    const later = DEPENDENCY_SOURCES.filter((source) => source.owningPhase !== '06');
    expect(later.length).toBeGreaterThan(0);
    for (const source of later) {
      if (!(await relationExists(source.relation))) continue;
      // The owning phase has arrived: it must have honoured the entry.
      expect({ id: source.id, column: await columnExists(source.relation, source.column) }).toEqual(
        {
          id: source.id,
          column: true,
        },
      );
      expect(await columnExists(source.relation, 'hotel_id')).toBe(true);
    }
  });

  it('the probe reports not_yet_provisioned for a later phase and clear for a fresh Phase 06 entity', async () => {
    const { hotelId, actor } = await env.hotelWithManager('Dependency Hotel', 'P25');
    const category = await env.catalog.createCategory(
      { hotelId, idempotencyKey: 'dep-cat-1', name: 'Standard', state: 'ACTIVE' },
      actor,
      { correlationId: 'dep-1', accountId: actor.principal.accountId },
    );
    const view = await env.lifecycle.view(
      { hotelId, kind: 'ROOM_CATEGORY', entityId: category.categoryId },
      actor,
      { correlationId: 'dep-2', accountId: actor.principal.accountId },
    );
    const byId = new Map(view.dependencies.map((fact) => [fact.sourceId, fact]));
    expect(byId.get('category.child_room')).toMatchObject({ state: 'clear', count: 0 });
    expect(byId.get('category.rate_snapshot')).toMatchObject({ state: 'clear', count: 0 });
    for (const source of DEPENDENCY_SOURCES.filter(
      (s) => s.entityKinds.includes('ROOM_CATEGORY') && s.owningPhase !== '06',
    )) {
      if (await relationExists(source.relation)) continue;
      expect(byId.get(source.id)).toMatchObject({ state: 'not_yet_provisioned' });
    }
    expect(view.blockers).toEqual([]);
  });
});
