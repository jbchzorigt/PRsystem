import { describe, expect, it } from 'vitest';
import { ENTITY_KINDS } from '../domain/lifecycle';
import { DEPENDENCY_SOURCES, sourcesFor } from './dependency-sources';

/**
 * The registry's own consistency. What it says about the live database is
 * `catalog.dependency.test.ts`, on real PostgreSQL.
 */
describe('the dependency registry', () => {
  it('has unique ids, a declared owning phase and a platform relation on every entry', () => {
    const ids = DEPENDENCY_SOURCES.map((source) => source.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const source of DEPENDENCY_SOURCES) {
      expect(source.owningPhase).toMatch(/^(0[6-9]|1[0-9]|2[0-3])$/);
      expect(source.relation).toMatch(/^platform\.[a-z_]+$/);
      expect(source.column).toMatch(/^[a-z_]+$/);
      expect(source.entityKinds.length).toBeGreaterThan(0);
      expect(source.detail.length).toBeGreaterThan(0);
    }
  });

  it('gives every entity kind at least one operational and one historical source', () => {
    for (const kind of ENTITY_KINDS) {
      const sources = sourcesFor(kind);
      expect({ kind, operational: sources.some((s) => s.kind === 'operational') }).toEqual({
        kind,
        operational: true,
      });
      expect({ kind, historical: sources.some((s) => s.kind === 'historical') }).toEqual({
        kind,
        historical: true,
      });
    }
  });

  it('names the RML-DEC-003 blockers of each kind', () => {
    const idsFor = (kind: (typeof ENTITY_KINDS)[number]): string[] =>
      sourcesFor(kind).map((s) => s.id);
    // Room: stay, task, reconciliation (stock and configuration). No booking
    // source: `BK-DEC-013` gives a booking a category unit, not a room, and it
    // reaches a room only by becoming the stay `room.active_stay` blocks on.
    expect(idsFor('ROOM')).toEqual(
      expect.arrayContaining([
        'room.active_stay',
        'room.cleaning_task',
        'room.minibar_stock',
        'room.minibar_configuration',
      ]),
    );
    // Category: dependent room, stay, booking.
    expect(idsFor('ROOM_CATEGORY')).toEqual(
      expect.arrayContaining([
        'category.child_room',
        'category.active_stay',
        'category.future_booking',
      ]),
    );
    // Product: pending refill, room stock, active configuration.
    expect(idsFor('MINIBAR_PRODUCT')).toEqual(
      expect.arrayContaining([
        'product.refill_task',
        'product.room_stock',
        'product.template_version_item',
      ]),
    );
    // Template: room assignment (stay and reconciliation ride on the room configuration).
    expect(idsFor('MINIBAR_TEMPLATE')).toEqual(
      expect.arrayContaining(['template.room_assignment', 'template.pending_target']),
    );
  });
});
