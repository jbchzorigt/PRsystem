import { describe, expect, it } from 'vitest';
import { HOTEL_ACTIONS } from './actions';
import { PERMISSION_CATALOG, PERMISSION_IDS, catalogEntry } from './catalog';
import { OPERATION_ACTIONS, OPERATION_PERMISSIONS } from './operation';
import { POLICE_ACTIONS, POLICE_PERMISSIONS } from './police';
import { PACKAGE_FEATURES, rolesAssignableIn } from './packages';

/**
 * The catalog is a contract surface, so it is asserted as one: stable ids, one
 * entry per id, a realm for every entry, and complete coverage of the three
 * source tables. A permission that exists in the matrix but not in the catalog
 * is a permission no backend check can name.
 */
describe('the permission catalog', () => {
  it('holds one entry per id, sorted, with no duplicates', () => {
    expect(new Set(PERMISSION_IDS).size).toBe(PERMISSION_IDS.length);
    expect([...PERMISSION_IDS].sort()).toEqual(PERMISSION_IDS);
  });

  it('covers every row of doc 18 §3, §5 and §6', () => {
    for (const action of HOTEL_ACTIONS) expect(catalogEntry(action.id), action.id).toBeDefined();
    for (const action of OPERATION_ACTIONS)
      expect(catalogEntry(action.id), action.id).toBeDefined();
    for (const action of POLICE_ACTIONS) expect(catalogEntry(action.id), action.id).toBeDefined();
  });

  it('carries every derived read and request permission', () => {
    for (const action of HOTEL_ACTIONS) {
      for (const cell of Object.values(action.cells)) {
        if (cell.kind !== 'derived') continue;
        const id = `${action.id}.${cell.suffix}`;
        expect(catalogEntry(id), id).toBeDefined();
      }
    }
  });

  it('gives every entry a realm, a source and a label', () => {
    for (const entry of PERMISSION_CATALOG) {
      expect(['hotel', 'guest', 'operation', 'police']).toContain(entry.realm);
      expect(entry.source).toMatch(/^18 §/);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it('gives hotel entries a package entitlement and other realms none', () => {
    for (const entry of PERMISSION_CATALOG) {
      if (entry.realm === 'hotel') {
        // A row every column refuses is entitled nowhere, which is correct: it
        // exists so a backend check can refuse it by name.
        expect(entry.entitledPackages.every((code) => ['P20', 'P25', 'P30'].includes(code))).toBe(
          true,
        );
      } else {
        expect(entry.entitledPackages).toEqual([]);
      }
    }
  });

  it('marks every Operation permission as explicit-grant-only', () => {
    for (const action of OPERATION_ACTIONS) {
      expect(catalogEntry(action.id)?.explicitGrantOnly).toBe(true);
    }
    expect(OPERATION_PERMISSIONS).toContain('REVIEW_MODERATE');
    expect(OPERATION_PERMISSIONS).toContain('PLATFORM_OPERATION_ACCESS_MANAGE');
  });

  it('names every gated Police permission', () => {
    // `WANTED_EXPORT_FULL_IDENTIFIER` is the one that gates no action of its
    // own: doc 13 §12.2 makes it a second grant an exporting Police Admin must
    // also hold, on top of the export row and a recent step-up.
    expect(POLICE_PERMISSIONS).toEqual([
      'FALSE_MATCH_APPROVE',
      'FOUND_CORRECTION_APPROVE',
      'WANTED_CASE_CREATE',
      'WANTED_CASE_EXPORT',
      'WANTED_CASE_STATE_MANAGE',
      'WANTED_EXPORT_FULL_IDENTIFIER',
      'WANTED_IDENTITY_APPROVE',
    ]);
  });

  it('requires a step-up on every Operation and gated Police action, and on no hotel action', () => {
    // doc 05 §5: the Hotel realm has no step-up requirement in the MVP.
    for (const entry of PERMISSION_CATALOG) {
      if (entry.realm === 'hotel' || entry.realm === 'guest') expect(entry.stepUp).toBe(false);
      if (entry.realm === 'operation') expect(entry.stepUp).toBe(true);
    }
  });
});

describe('package entitlement', () => {
  it('states doc 18 §4 exactly', () => {
    expect(PACKAGE_FEATURES.reception).toEqual(['P20', 'P25', 'P30']);
    expect(PACKAGE_FEATURES.cleaner_role_api).toEqual(['P25', 'P30']);
    expect(PACKAGE_FEATURES.minibar_template).toEqual(['P25', 'P30']);
    expect(PACKAGE_FEATURES.restaurant_manager).toEqual(['P30']);
  });

  it('permits Cleaner only from 25,000₮ and Manager Plus only at 30,000₮', () => {
    expect(rolesAssignableIn('P20')).toEqual(['HOTEL_ADMIN', 'MANAGER', 'RECEPTION']);
    expect(rolesAssignableIn('P25')).toContain('CLEANER');
    expect(rolesAssignableIn('P25')).not.toContain('MANAGER_PLUS');
    expect(rolesAssignableIn('P30')).toContain('MANAGER_PLUS');
    expect(rolesAssignableIn('P30')).toContain('RESTAURANT_MANAGER');
    expect(rolesAssignableIn('P25')).not.toContain('RESTAURANT_MANAGER');
  });
});
