import { describe, expect, it } from 'vitest';
import type { AuthorizationInput, Principal } from './pipeline';
import { authorize } from './pipeline';

/**
 * The Operation, Police and Guest halves of the pipeline (doc 18 §5, §6,
 * doc 06 §4.3).
 *
 * Every case here is a **negative**: a stored permission string, a role that may
 * not hold the action, an absent owner. The property under test is that none of
 * them can be turned into a grant by writing a row — the canonical matrix
 * decides, and a row that the matrix does not describe is inert.
 */

const NOW = new Date('2026-08-31T09:00:00.000Z');
const ACCOUNT = '44444444-4444-4444-8444-444444444444';
const OTHER_ACCOUNT = '55555555-5555-4555-8555-555555555555';

function principal(overrides: Partial<Principal>): Principal {
  return {
    accountId: ACCOUNT,
    realm: 'operation',
    accountState: 'ACTIVE',
    memberships: [],
    directPermissions: [],
    stepUpAt: NOW,
    ...overrides,
  };
}

function input(overrides: Partial<AuthorizationInput>): AuthorizationInput {
  return {
    endpointRealm: 'operation',
    permission: 'operation.hotel_subscription_list',
    principal: principal({}),
    target: {},
    now: NOW,
    ...overrides,
  };
}

describe('doc 18 §5 — Operation and Platform Super Admin', () => {
  it('allows a row the matrix grants, to an account holding the named permission', () => {
    const decision = authorize(
      input({
        permission: 'operation.hotel_subscription_list',
        principal: principal({
          realmRole: 'OPERATION_ADMIN',
          directPermissions: ['OPERATION_READ'],
        }),
      }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('refuses a row the document refuses to both columns, however the grant is stored', () => {
    // `Хэрэглэгчийн одоогийн/шинэ password, OTP/token харах` is refused to
    // Operation Admin *and* to Platform Super Admin. Storing the row's dotted
    // action id, or its label as a permission, must change nothing.
    for (const stored of [
      'operation.credential_material_view',
      'CREDENTIAL_MATERIAL_VIEW',
      'OPERATION_READ',
    ]) {
      const decision = authorize(
        input({
          permission: 'operation.credential_material_view',
          principal: principal({
            realmRole: 'PLATFORM_SUPER_ADMIN',
            directPermissions: [stored],
          }),
        }),
      );
      expect({ stored, ...decision }).toMatchObject({
        stored,
        allowed: false,
        code: 'NOT_AUTHORIZED',
      });
    }
  });

  it('refuses a Platform-only row to an Operation Admin holding the permission name', () => {
    const decision = authorize(
      input({
        permission: 'operation.subscription_suspend',
        principal: principal({
          realmRole: 'OPERATION_ADMIN',
          directPermissions: ['SUBSCRIPTION_SUSPEND'],
        }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, code: 'NOT_AUTHORIZED' });
  });

  it('refuses the dotted action id where the canonical permission name is required', () => {
    const decision = authorize(
      input({
        permission: 'operation.subscription_suspend',
        principal: principal({
          realmRole: 'PLATFORM_SUPER_ADMIN',
          directPermissions: ['operation.subscription_suspend'],
        }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, code: 'NOT_AUTHORIZED' });
  });

  it('refuses an account with no realm role at all', () => {
    const decision = authorize(
      input({
        permission: 'operation.review_moderate',
        principal: principal({ directPermissions: ['REVIEW_MODERATE'] }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, code: 'NOT_AUTHORIZED' });
  });
});

describe('doc 18 §6 — Police', () => {
  function police(overrides: Partial<Principal>): Principal {
    return principal({ realm: 'police', ...overrides });
  }

  it('refuses the bulk check-in export to both roles, however the grant is stored', () => {
    for (const role of ['POLICE_OFFICER', 'POLICE_ADMIN'] as const) {
      for (const stored of ['police.all_hotel_checkin_export', 'WANTED_CASE_EXPORT']) {
        const decision = authorize(
          input({
            endpointRealm: 'police',
            permission: 'police.all_hotel_checkin_export',
            principal: police({ realmRole: role, directPermissions: [stored] }),
          }),
        );
        expect({ role, stored, ...decision }).toMatchObject({
          role,
          stored,
          allowed: false,
          code: 'NOT_AUTHORIZED',
        });
      }
    }
  });

  it('refuses an Officer the Wanted Case export the matrix gives only to an Admin', () => {
    const decision = authorize(
      input({
        endpointRealm: 'police',
        permission: 'police.wanted_case_export',
        principal: police({
          realmRole: 'POLICE_OFFICER',
          directPermissions: ['WANTED_CASE_EXPORT'],
        }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, code: 'NOT_AUTHORIZED' });
  });

  it('allows an Admin the Wanted Case export with the named permission', () => {
    const decision = authorize(
      input({
        endpointRealm: 'police',
        permission: 'police.wanted_case_export',
        principal: police({
          realmRole: 'POLICE_ADMIN',
          directPermissions: ['WANTED_CASE_EXPORT'],
        }),
      }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('refuses an Officer a row the matrix denies even though no permission exists for it', () => {
    const decision = authorize(
      input({
        endpointRealm: 'police',
        permission: 'police.all_hotel_checkin_list',
        principal: police({ realmRole: 'POLICE_OFFICER' }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, code: 'NOT_AUTHORIZED' });
  });

  it('allows a plain matrix ✓ with no named permission', () => {
    const decision = authorize(
      input({
        endpointRealm: 'police',
        permission: 'police.wanted_active_view',
        principal: police({ realmRole: 'POLICE_OFFICER' }),
      }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('refuses an approval by the account that requested it (doc 05 §3.2)', () => {
    const decision = authorize(
      input({
        endpointRealm: 'police',
        permission: 'police.found_correction_decide',
        principal: police({
          realmRole: 'POLICE_ADMIN',
          directPermissions: ['FOUND_CORRECTION_APPROVE'],
        }),
        separationCounterpartAccountId: ACCOUNT,
      }),
    );
    expect(decision).toMatchObject({ allowed: false, code: 'SEPARATION_OF_DUTIES' });
  });

  it('refuses an approval whose counterpart the caller did not load', () => {
    // Fail closed: an unknown requester is not a different requester.
    const decision = authorize(
      input({
        endpointRealm: 'police',
        permission: 'police.found_correction_decide',
        principal: police({
          realmRole: 'POLICE_ADMIN',
          directPermissions: ['FOUND_CORRECTION_APPROVE'],
        }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, code: 'SEPARATION_OF_DUTIES' });
  });

  it('allows an approval by a different account', () => {
    const decision = authorize(
      input({
        endpointRealm: 'police',
        permission: 'police.found_correction_decide',
        principal: police({
          realmRole: 'POLICE_ADMIN',
          directPermissions: ['FOUND_CORRECTION_APPROVE'],
        }),
        separationCounterpartAccountId: OTHER_ACCOUNT,
      }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('confines an Officer match alert to their own police scope', () => {
    const scoped = police({ realmRole: 'POLICE_OFFICER', policeScopeRef: 'unit-a' });
    expect(
      authorize(
        input({
          endpointRealm: 'police',
          permission: 'police.match_alert_view',
          principal: scoped,
          resourceScopeRef: 'unit-b',
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'NOT_AUTHORIZED' });
    expect(
      authorize(
        input({
          endpointRealm: 'police',
          permission: 'police.match_alert_view',
          principal: scoped,
          resourceScopeRef: 'unit-a',
        }),
      ).allowed,
    ).toBe(true);
    // Absent scope is refused, not waved through.
    expect(
      authorize(
        input({
          endpointRealm: 'police',
          permission: 'police.match_alert_view',
          principal: scoped,
        }),
      ),
    ).toMatchObject({ allowed: false, code: 'NOT_AUTHORIZED' });
  });
});

describe('doc 06 §4.3 — Guest ownership', () => {
  function guest(overrides: Partial<Principal> = {}): Principal {
    // No realm role at all: the Guest realm has none, and ownership is the only
    // question it asks (doc 06 §4.3).
    return principal({ realm: 'guest', ...overrides });
  }

  it('refuses an ownership action whose owner was never loaded', () => {
    const decision = authorize(
      input({ endpointRealm: 'guest', permission: 'booking.cancel_own', principal: guest() }),
    );
    expect(decision).toMatchObject({ allowed: false, stage: 'scope', code: 'NOT_AUTHORIZED' });
  });

  it('refuses an ownership action on another account’s booking', () => {
    const decision = authorize(
      input({
        endpointRealm: 'guest',
        permission: 'booking.cancel_own',
        principal: guest(),
        resourceOwnerAccountId: OTHER_ACCOUNT,
      }),
    );
    expect(decision).toMatchObject({ allowed: false, stage: 'scope', code: 'NOT_AUTHORIZED' });
  });

  it('allows an ownership action on the caller’s own booking', () => {
    const decision = authorize(
      input({
        endpointRealm: 'guest',
        permission: 'booking.cancel_own',
        principal: guest(),
        resourceOwnerAccountId: ACCOUNT,
      }),
    );
    expect(decision.allowed).toBe(true);
  });
});
