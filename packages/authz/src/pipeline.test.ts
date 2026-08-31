import { describe, expect, it } from 'vitest';
import type { AuthorizationInput, Principal, ResolvedMembership } from './pipeline';
import { INDISTINGUISHABLE_STAGES, STEP_UP_WINDOW_MINUTES, authorize } from './pipeline';
import type { SubscriptionSnapshot } from './subscription';
import type { HotelRole } from './roles';
import type { PackageCode } from './packages';

const NOW = new Date('2026-08-31T09:00:00.000Z');
const HOTEL_A = '11111111-1111-4111-8111-111111111111';
const HOTEL_B = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';

function membership(
  hotelId: string,
  roles: readonly HotelRole[],
  overrides: Partial<ResolvedMembership> = {},
): ResolvedMembership {
  return {
    membershipId: `m-${hotelId}`,
    hotelId,
    state: 'ACTIVE',
    roles,
    revision: 1,
    ...overrides,
  };
}

function subscription(
  effectivePackage: PackageCode,
  overrides: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot {
  return {
    hotelId: HOTEL_A,
    state: 'ACTIVE',
    effectivePackage,
    asOf: NOW,
    ...overrides,
  };
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    accountId: ACCOUNT,
    realm: 'hotel',
    accountState: 'ACTIVE',
    memberships: [membership(HOTEL_A, ['RECEPTION'])],
    directPermissions: [],
    ...overrides,
  };
}

function input(overrides: Partial<AuthorizationInput> = {}): AuthorizationInput {
  return {
    endpointRealm: 'hotel',
    permission: 'hotel.stay.check_in',
    principal: principal(),
    target: { hotelId: HOTEL_A },
    subscription: subscription('P30'),
    now: NOW,
    ...overrides,
  };
}

describe('the seven-stage pipeline', () => {
  it('allows an action every stage passes', () => {
    const decision = authorize(input());
    expect(decision.allowed).toBe(true);
    if (decision.allowed) expect(decision.membership?.hotelId).toBe(HOTEL_A);
  });

  it('refuses an unknown permission rather than treating it as ungranted', () => {
    const decision = authorize(input({ permission: 'hotel.invented.action' }));
    expect(decision).toMatchObject({ allowed: false, code: 'UNKNOWN_PERMISSION' });
  });

  it('stage 1 refuses a principal from another realm', () => {
    const decision = authorize(
      input({ principal: principal({ realm: 'operation' }), endpointRealm: 'hotel' }),
    );
    expect(decision).toMatchObject({ allowed: false, stage: 'realm', code: 'REALM_MISMATCH' });
  });

  it('stage 1 refuses a hotel permission on an operation endpoint', () => {
    const decision = authorize(
      input({ endpointRealm: 'operation', principal: principal({ realm: 'operation' }) }),
    );
    expect(decision).toMatchObject({ allowed: false, stage: 'realm', code: 'REALM_MISMATCH' });
  });

  it('stage 2 refuses a suspended account', () => {
    const decision = authorize(input({ principal: principal({ accountState: 'SUSPENDED' }) }));
    expect(decision).toMatchObject({
      allowed: false,
      stage: 'account_and_membership',
      code: 'NOT_AUTHORIZED',
    });
  });

  it('stage 2 refuses a suspended membership', () => {
    const decision = authorize(
      input({
        principal: principal({
          memberships: [membership(HOTEL_A, ['RECEPTION'], { state: 'SUSPENDED' })],
        }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, stage: 'account_and_membership' });
  });

  it('stage 2 refuses a membership that is still only invited', () => {
    const decision = authorize(
      input({
        principal: principal({
          memberships: [membership(HOTEL_A, ['RECEPTION'], { state: 'PENDING' })],
        }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, stage: 'account_and_membership' });
  });

  it('stage 3 refuses a role that does not name the permission', () => {
    const decision = authorize(
      input({
        permission: 'hotel.finance.dashboard_full',
        principal: principal({ memberships: [membership(HOTEL_A, ['RECEPTION'])] }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, stage: 'named_permission' });
  });

  it('stages 2, 3 and 4 return one indistinguishable denial code', () => {
    const denials = [
      authorize(input({ principal: principal({ memberships: [] }) })),
      authorize(
        input({
          permission: 'hotel.finance.dashboard_full',
          principal: principal({ memberships: [membership(HOTEL_A, ['RECEPTION'])] }),
        }),
      ),
      authorize(
        input({
          permission: 'restaurant.order_process',
          target: { hotelId: HOTEL_A, restaurantId: 'r-2' },
          // A Restaurant Manager for r-1, asking about r-2: the permission is
          // granted and the scope is not (doc 06 §4.1).
          principal: principal({
            memberships: [membership(HOTEL_A, ['RESTAURANT_MANAGER'], { restaurantId: 'r-1' })],
          }),
        }),
      ),
    ];
    for (const decision of denials) {
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(INDISTINGUISHABLE_STAGES).toContain(decision.stage);
        expect(decision.code).toBe('NOT_AUTHORIZED');
      }
    }
  });

  it('never unions permissions across hotels', () => {
    // doc 06 §6. The Manager membership in hotel B must not open a Manager
    // action in hotel A.
    const decision = authorize(
      input({
        permission: 'hotel.catalog.room_manage',
        target: { hotelId: HOTEL_A },
        principal: principal({
          memberships: [membership(HOTEL_A, ['RECEPTION']), membership(HOTEL_B, ['MANAGER'])],
        }),
      }),
    );
    expect(decision).toMatchObject({ allowed: false, code: 'NOT_AUTHORIZED' });
  });

  it('refuses a target hotel the account holds no membership in', () => {
    const decision = authorize(input({ target: { hotelId: HOTEL_B } }));
    expect(decision).toMatchObject({ allowed: false, stage: 'account_and_membership' });
  });

  it('gives Hotel Admin no operational rights without the extra role', () => {
    // `RBAC-DEC-001`, doc 18 §9.
    const admin = principal({ memberships: [membership(HOTEL_A, ['HOTEL_ADMIN'])] });
    for (const permission of [
      'hotel.stay.check_in',
      'hotel.catalog.room_manage',
      'hotel.cash.count',
      'hotel.deposit.collect_deduct_refund',
      'hotel.handoff.reception_cleaner_claim',
    ]) {
      expect(authorize(input({ permission, principal: admin })).allowed, permission).toBe(false);
    }
    // With the operational role held separately, the same actions pass.
    const both = principal({
      memberships: [membership(HOTEL_A, ['HOTEL_ADMIN', 'RECEPTION', 'MANAGER'])],
    });
    for (const permission of ['hotel.stay.check_in', 'hotel.catalog.room_manage']) {
      expect(authorize(input({ permission, principal: both })).allowed, permission).toBe(true);
    }
  });

  it('refuses a Manager Plus role created on a 25,000₮ hotel, and its actions', () => {
    // doc 18 §4: the role assignment and the action API are both gated.
    const decision = authorize(
      input({
        permission: 'hotel.restaurant.register',
        principal: principal({ memberships: [membership(HOTEL_A, ['MANAGER_PLUS'])] }),
        subscription: subscription('P25'),
      }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(['named_permission', 'package_entitlement']).toContain(decision.stage);
    }
  });

  it('stage 5 refuses an action the package does not entitle', () => {
    const decision = authorize(
      input({
        permission: 'hotel.minibar.product_manage',
        principal: principal({ memberships: [membership(HOTEL_A, ['MANAGER'])] }),
        subscription: subscription('P20'),
      }),
    );
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(['named_permission', 'package_entitlement']).toContain(decision.stage);
    }
  });

  it('fails closed when the subscription contract cannot answer', () => {
    const { subscription: _dropped, ...rest } = input();
    const decision = authorize(rest);
    expect(decision).toMatchObject({
      allowed: false,
      stage: 'package_entitlement',
      code: 'SUBSCRIPTION_STATE_UNAVAILABLE',
    });
  });

  it('gives the 48-hour grace window full rights', () => {
    // `LIFE-DEC-003`: grace is not a degraded mode.
    const decision = authorize(
      input({
        subscription: subscription('P30', {
          state: 'GRACE',
          graceExpiresAt: new Date(NOW.getTime() + 3_600_000),
        }),
      }),
    );
    expect(decision.allowed).toBe(true);
  });

  it('denies the whole operational matrix once grace has elapsed', () => {
    const expired = subscription('P30', { state: 'EXPIRED' });
    const decision = authorize(input({ subscription: expired }));
    expect(decision).toMatchObject({
      allowed: false,
      stage: 'state',
      code: 'SUBSCRIPTION_EXPIRED',
    });
  });

  it('leaves renewal, help and logout after a hard lock, and renewal only to Hotel Admin', () => {
    const expired = subscription('P30', { state: 'EXPIRED' });
    const admin = principal({ memberships: [membership(HOTEL_A, ['HOTEL_ADMIN'])] });
    const reception = principal({ memberships: [membership(HOTEL_A, ['RECEPTION'])] });

    expect(
      authorize(
        input({ permission: 'hotel.subscription.pay', principal: admin, subscription: expired }),
      ).allowed,
    ).toBe(true);
    expect(
      authorize(
        input({
          permission: 'hotel.subscription.pay',
          principal: reception,
          subscription: expired,
        }),
      ).allowed,
    ).toBe(false);

    for (const permission of ['platform.help', 'platform.logout', 'platform.expired_notice']) {
      for (const actor of [admin, reception]) {
        expect(
          authorize(input({ permission, principal: actor, subscription: expired })).allowed,
          permission,
        ).toBe(true);
      }
    }
  });

  it('denies immediately on a suspended subscription', () => {
    const decision = authorize(
      input({ subscription: subscription('P30', { state: 'SUSPENDED' }) }),
    );
    expect(decision).toMatchObject({ allowed: false, stage: 'state', code: 'ACCOUNT_SUSPENDED' });
  });

  it('re-evaluates state on every call rather than trusting a stored flag', () => {
    // The same principal, the same permission, two snapshots: the decision
    // follows the snapshot, so a session cannot survive the grace boundary.
    const before = authorize(input({ subscription: subscription('P30', { state: 'GRACE' }) }));
    const after = authorize(input({ subscription: subscription('P30', { state: 'EXPIRED' }) }));
    expect(before.allowed).toBe(true);
    expect(after.allowed).toBe(false);
  });
});

describe('Operation and Police realms', () => {
  const operation = (permissions: readonly string[], stepUpAt?: Date): Principal => ({
    accountId: ACCOUNT,
    realm: 'operation',
    accountState: 'ACTIVE',
    memberships: [],
    directPermissions: permissions,
    ...(stepUpAt === undefined ? {} : { stepUpAt }),
  });

  it('grants an Operation action only to an account holding it explicitly', () => {
    const allowed = authorize({
      endpointRealm: 'operation',
      permission: 'operation.subscription_reminder_send',
      principal: operation(['operation.subscription_reminder_send'], NOW),
      target: {},
      now: NOW,
    });
    expect(allowed.allowed).toBe(true);

    const refused = authorize({
      endpointRealm: 'operation',
      permission: 'operation.subscription_reminder_send',
      principal: operation([], NOW),
      target: {},
      now: NOW,
    });
    expect(refused).toMatchObject({ allowed: false, stage: 'named_permission' });
  });

  it('requires a recent step-up on a high-risk Operation action', () => {
    const stale = new Date(NOW.getTime() - (STEP_UP_WINDOW_MINUTES + 1) * 60_000);
    const decision = authorize({
      endpointRealm: 'operation',
      permission: 'operation.subscription_suspend',
      principal: operation(['operation.subscription_suspend'], stale),
      target: {},
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: false, stage: 'step_up', code: 'STEP_UP_REQUIRED' });
  });

  it('refuses an Operation action with no step-up at all', () => {
    const decision = authorize({
      endpointRealm: 'operation',
      permission: 'operation.subscription_suspend',
      principal: operation(['operation.subscription_suspend']),
      target: {},
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: false, code: 'STEP_UP_REQUIRED' });
  });

  it('keeps an Operation principal out of the Hotel realm', () => {
    const decision = authorize({
      endpointRealm: 'hotel',
      permission: 'hotel.registry.list_view',
      principal: operation(['hotel.registry.list_view'], NOW),
      target: { hotelId: HOTEL_A },
      subscription: subscription('P30'),
      now: NOW,
    });
    expect(decision).toMatchObject({ allowed: false, stage: 'realm', code: 'REALM_MISMATCH' });
  });

  it('keeps a Police principal out of the Hotel realm and vice versa', () => {
    const police: Principal = {
      accountId: ACCOUNT,
      realm: 'police',
      accountState: 'ACTIVE',
      memberships: [],
      directPermissions: ['police.wanted_active_view'],
      stepUpAt: NOW,
    };
    expect(
      authorize({
        endpointRealm: 'hotel',
        permission: 'hotel.stay.check_in',
        principal: police,
        target: { hotelId: HOTEL_A },
        subscription: subscription('P30'),
        now: NOW,
      }),
    ).toMatchObject({ code: 'REALM_MISMATCH' });

    expect(
      authorize({
        endpointRealm: 'police',
        permission: 'police.wanted_active_view',
        principal: police,
        target: {},
        now: NOW,
      }).allowed,
    ).toBe(true);
  });
});

describe('the Guest realm', () => {
  const guest: Principal = {
    accountId: ACCOUNT,
    realm: 'guest',
    accountState: 'ACTIVE',
    memberships: [],
    directPermissions: [],
  };

  it('allows the booking owner and refuses everybody else', () => {
    expect(
      authorize({
        endpointRealm: 'guest',
        permission: 'booking.cancel_own',
        principal: guest,
        target: {},
        resourceOwnerAccountId: ACCOUNT,
        now: NOW,
      }).allowed,
    ).toBe(true);

    expect(
      authorize({
        endpointRealm: 'guest',
        permission: 'booking.cancel_own',
        principal: guest,
        target: {},
        resourceOwnerAccountId: 'someone-else',
        now: NOW,
      }),
    ).toMatchObject({ allowed: false, stage: 'scope' });
  });

  it('does not let any hotel role cancel a guest booking', () => {
    for (const role of ['HOTEL_ADMIN', 'MANAGER', 'MANAGER_PLUS', 'RECEPTION'] as HotelRole[]) {
      const decision = authorize(
        input({
          permission: 'booking.cancel_own',
          principal: principal({ memberships: [membership(HOTEL_A, [role])] }),
        }),
      );
      expect(decision).toMatchObject({ allowed: false, code: 'REALM_MISMATCH' });
    }
  });
});
