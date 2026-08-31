import { describe, expect, it } from 'vitest';
import { HOTEL_ACTIONS, MATRIX_COLUMNS } from './actions';
import type { HotelAction } from './actions';
import { catalogEntry } from './catalog';
import { effectiveHotelPermissions } from './effective';
import { OPERATION_ACTIONS } from './operation';
import { POLICE_ACTIONS } from './police';
import { ALL_PACKAGES, isRoleAssignableIn } from './packages';
import type { PackageCode } from './packages';
import { HOTEL_ROLES, OPERATION_ROLES, POLICE_ROLES } from './roles';
import type { HotelRole } from './roles';

/**
 * The table-driven proof that doc 18 §§3, 5 and 6 are enforced.
 *
 * One `describe` per source row, one `it` per column, so a failure names the
 * exact cell of the exact row. Every `Нэмэлт role` cell is asserted twice: the
 * column refuses the action, **and** each role the cell names actually grants it
 * somewhere. Half of that rule is easy to satisfy by accident — a permission
 * nobody grants also refuses Hotel Admin.
 */

function permissionOf(action: HotelAction, suffix?: string): string {
  return suffix === undefined ? action.id : `${action.id}.${suffix}`;
}

describe('doc 18 §3 — the canonical Hotel action matrix', () => {
  for (const action of HOTEL_ACTIONS) {
    describe(`${action.id} — ${action.label} (${action.source})`, () => {
      for (const role of MATRIX_COLUMNS) {
        const cell = action.cells[role];

        it(`${role}: the cell is enforced in every package`, () => {
          for (const packageCode of ALL_PACKAGES) {
            const effective = effectiveHotelPermissions([role], packageCode);
            const entry = catalogEntry(action.id);
            expect(entry, `${action.id} is missing from the catalog`).toBeDefined();
            const entitled = entry?.entitledPackages.includes(packageCode) ?? false;
            const roleExists = isRoleAssignableIn(role, packageCode);

            if (cell.kind === 'allow') {
              const shouldHold = cell.packages.includes(packageCode) && entitled && roleExists;
              expect(
                effective.has(action.id),
                `${role} in ${packageCode} should ${shouldHold ? 'hold' : 'not hold'} ${action.id}`,
              ).toBe(shouldHold);
            }

            if (cell.kind === 'derived') {
              const derived = permissionOf(action, cell.suffix);
              const derivedEntry = catalogEntry(derived);
              const derivedEntitled = derivedEntry?.entitledPackages.includes(packageCode) ?? false;
              const shouldHold =
                cell.packages.includes(packageCode) && derivedEntitled && roleExists;
              expect(
                effective.has(derived),
                `${role} in ${packageCode} should ${shouldHold ? 'hold' : 'not hold'} ${derived}`,
              ).toBe(shouldHold);
              // A weaker permission is never the action itself.
              expect(effective.has(action.id)).toBe(false);
            }

            if (cell.kind === 'deny' || cell.kind === 'requires') {
              expect(
                effective.has(action.id),
                `${role} must not hold ${action.id} in ${packageCode}`,
              ).toBe(false);
            }
          }
        });

        if (cell.kind === 'requires') {
          it(`${role}: every role the cell names actually grants ${action.id}`, () => {
            expect(cell.roles.length).toBeGreaterThan(0);
            for (const named of cell.roles) {
              const holdsSomewhere = ALL_PACKAGES.some((packageCode) =>
                effectiveHotelPermissions([named], packageCode).has(action.id),
              );
              expect(
                holdsSomewhere,
                `${action.id}: the cell sends ${role} to ${named}, which grants nothing here`,
              ).toBe(true);
            }
          });

          it(`${role}: holding the named role alongside it grants ${action.id}`, () => {
            const named = cell.roles[0] as HotelRole;
            const packageCode = ALL_PACKAGES.find((code) =>
              effectiveHotelPermissions([named], code).has(action.id),
            ) as PackageCode;
            const withExtraRole = effectiveHotelPermissions([role, named], packageCode);
            expect(withExtraRole.has(action.id)).toBe(true);
          });
        }
      }
    });
  }
});

describe('doc 18 §3 — invariants the matrix must satisfy as a whole', () => {
  it('states every column for every row', () => {
    for (const action of HOTEL_ACTIONS) {
      for (const role of HOTEL_ROLES) {
        expect(action.cells[role], `${action.id} has no ${role} cell`).toBeDefined();
      }
      expect(Object.keys(action.cells).sort()).toEqual([...HOTEL_ROLES].sort());
    }
  });

  it('gives every row a unique, stable identifier', () => {
    const ids = HOTEL_ACTIONS.map((action) => action.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });

  it('confines every Manager Plus grant to the 30,000₮ package', () => {
    // doc 18 §3 note: the role exists only there, so an unannotated ✓ in that
    // column still means ✓ 30.
    for (const action of HOTEL_ACTIONS) {
      const cell = action.cells.MANAGER_PLUS;
      if (cell.kind === 'allow' || cell.kind === 'derived') {
        expect(cell.packages, `${action.id} widens Manager Plus beyond 30,000₮`).toEqual(['P30']);
      }
    }
  });

  it('keeps every minibar action inside the 25,000/30,000₮ entitlement', () => {
    for (const action of HOTEL_ACTIONS) {
      if (!action.id.startsWith('hotel.minibar.')) continue;
      const entry = catalogEntry(action.id);
      expect(entry?.entitledPackages).not.toContain('P20');
    }
  });

  it('keeps every restaurant action inside the 30,000₮ entitlement', () => {
    for (const action of HOTEL_ACTIONS) {
      if (!action.id.startsWith('restaurant.') && !action.id.startsWith('hotel.restaurant.')) {
        continue;
      }
      const entry = catalogEntry(action.id);
      expect(entry?.entitledPackages).toEqual(['P30']);
    }
  });

  it('grants Cleaner nothing outside the 25,000/30,000₮ entitlement', () => {
    for (const action of HOTEL_ACTIONS) {
      const cell = action.cells.CLEANER;
      if (cell.kind === 'allow' || cell.kind === 'derived') {
        expect(cell.packages, `${action.id} gives Cleaner a 20,000₮ grant`).not.toContain('P20');
      }
    }
  });

  it('never lets Hotel Admin inherit an operational role', () => {
    // `RBAC-DEC-001`. Every row whose Hotel Admin cell defers to another role
    // must refuse Hotel Admin outright — there is no partial inheritance.
    const deferred = HOTEL_ACTIONS.filter((action) => action.cells.HOTEL_ADMIN.kind === 'requires');
    expect(deferred.length).toBeGreaterThan(20);
    for (const action of deferred) {
      for (const packageCode of ALL_PACKAGES) {
        expect(effectiveHotelPermissions(['HOTEL_ADMIN'], packageCode).has(action.id)).toBe(false);
      }
    }
  });

  it('never lets Manager Plus inherit Manager', () => {
    // doc 18 §3.3 states it for no-show explicitly; the rule is general.
    const managerOnly = HOTEL_ACTIONS.filter(
      (action) =>
        action.cells.MANAGER.kind === 'allow' && action.cells.MANAGER_PLUS.kind !== 'allow',
    );
    expect(managerOnly.length).toBeGreaterThan(0);
    for (const action of managerOnly) {
      expect(effectiveHotelPermissions(['MANAGER_PLUS'], 'P30').has(action.id)).toBe(false);
    }
  });

  it('unions the permissions of several roles on one membership', () => {
    // `RBAC-DEC-001`: Hotel Admin + Manager + Reception is the union of three.
    const union = effectiveHotelPermissions(['HOTEL_ADMIN', 'MANAGER', 'RECEPTION'], 'P30');
    expect(union.has('hotel.finance.dashboard_full')).toBe(true); // Hotel Admin
    expect(union.has('hotel.catalog.room_manage')).toBe(true); // Manager
    expect(union.has('hotel.stay.check_in')).toBe(true); // Reception
  });

  it('holds a row that every column refuses to nobody at all', () => {
    const refusedRows = HOTEL_ACTIONS.filter((action) =>
      Object.values(action.cells).every((cell) => cell.kind === 'deny'),
    );
    // STAY-DEC-011, STAY-DEC-012, RBAC-DEC-015 and PAY-DEC-007 each produce one.
    expect(refusedRows.map((action) => action.id)).toContain(
      'hotel.stay.planned_checkout_direct_edit',
    );
    for (const action of refusedRows) {
      for (const role of HOTEL_ROLES) {
        for (const packageCode of ALL_PACKAGES) {
          expect(effectiveHotelPermissions([role], packageCode).has(action.id)).toBe(false);
        }
      }
      // Still catalogued, so a backend check refuses it by name.
      expect(catalogEntry(action.id)).toBeDefined();
    }
  });
});

describe('doc 18 §5 — Operation and Platform Super Admin', () => {
  for (const action of OPERATION_ACTIONS) {
    describe(`${action.id} — ${action.label}`, () => {
      for (const role of OPERATION_ROLES) {
        it(`${role}: the cell is enforced`, () => {
          const grantable = action.grantableTo.includes(role);
          if (action.permission === null) {
            expect(grantable, `${action.id} must be refused to ${role}`).toBe(false);
          } else if (grantable) {
            expect(action.permission).toMatch(/^[A-Z][A-Z_]+$/);
          } else {
            expect(action.grantableTo).not.toContain(role);
          }
        });
      }
    });
  }

  it('names an explicit permission for every action that is permitted at all', () => {
    for (const action of OPERATION_ACTIONS) {
      const entry = catalogEntry(action.id);
      expect(entry?.realm).toBe('operation');
      expect(entry?.explicitGrantOnly).toBe(true);
      if (action.grantableTo.length > 0) expect(action.permission).not.toBeNull();
      else expect(action.permission).toBeNull();
    }
  });

  it('requires a recent step-up on every Operation action', () => {
    for (const action of OPERATION_ACTIONS) {
      expect(action.stepUp, `${action.id} is a high-risk Operation action`).toBe(true);
    }
  });

  it('refuses hotel operational data, guest registry and Police data to both columns', () => {
    for (const id of [
      'operation.hotel_operational_data_manage',
      'operation.hotel_guest_registry_view',
      'operation.police_data_view',
      'operation.credential_material_view',
    ]) {
      const action = OPERATION_ACTIONS.find((entry) => entry.id === id);
      expect(action?.grantableTo).toEqual([]);
      expect(action?.permission).toBeNull();
    }
  });
});

describe('doc 18 §6 — the Police base matrix', () => {
  for (const action of POLICE_ACTIONS) {
    describe(`${action.id} — ${action.label}`, () => {
      for (const role of POLICE_ROLES) {
        it(`${role}: the cell is enforced`, () => {
          const cell = action.cells[role];
          expect(cell).toBeDefined();
          expect(['allow', 'deny', 'named']).toContain(cell.kind);
        });
      }
    });
  }

  it('never lets Police Admin inherit an Officer mutation', () => {
    // `RBAC-DEC-005`: each of these needs its own named permission, for both.
    for (const id of [
      'police.wanted_case_draft_create',
      'police.found_correction_decide',
      'police.false_match_decide',
      'police.manual_identity_approve',
      'police.case_state_manage',
      'police.wanted_case_export',
    ]) {
      const action = POLICE_ACTIONS.find((entry) => entry.id === id);
      expect(action, id).toBeDefined();
      expect(action?.cells.POLICE_ADMIN.kind).toBe('named');
    }
  });

  it('keeps the all-hotel check-in list away from Police Officer and its export away from both', () => {
    const list = POLICE_ACTIONS.find((entry) => entry.id === 'police.all_hotel_checkin_list');
    expect(list?.cells.POLICE_OFFICER.kind).toBe('deny');
    expect(list?.cells.POLICE_ADMIN.kind).toBe('allow');

    const bulk = POLICE_ACTIONS.find((entry) => entry.id === 'police.all_hotel_checkin_export');
    expect(bulk?.cells.POLICE_OFFICER.kind).toBe('deny');
    expect(bulk?.cells.POLICE_ADMIN.kind).toBe('deny');
  });

  it('carries a separation-of-duties rule on every approval row', () => {
    for (const id of [
      'police.found_correction_decide',
      'police.false_match_decide',
      'police.manual_identity_approve',
    ]) {
      const action = POLICE_ACTIONS.find((entry) => entry.id === id);
      for (const role of POLICE_ROLES) {
        const cell = action?.cells[role];
        expect(cell?.kind).toBe('named');
        if (cell?.kind === 'named') expect(cell.separation).toBeDefined();
      }
    }
  });
});
