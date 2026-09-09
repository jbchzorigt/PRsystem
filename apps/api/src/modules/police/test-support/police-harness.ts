import { Pool } from 'pg';
import type { PoliceRole } from '@prsystem/authz';
import { PLATFORM_SCOPE, withTenantTransaction } from '@prsystem/db';
import {
  SimulatedObjectStorage,
  SimulatedSms,
  SimulatedXypIdentity,
  encryptValue,
} from '@prsystem/ports';
import { TEST_LOGIN_PASSWORD, TEST_LOGIN_PRINCIPALS } from '@prsystem/testing';
import type { CommandActor } from '../../iam/services/iam-context';
import { RepositoryPoliceAccounts } from '../../iam/contracts/police-accounts';
import type { StayHarness, StayHotel } from '../../stay/test-support/stay-harness';
import { createStayHarness, key, request } from '../../stay/test-support/stay-harness';
import type { PoliceDependencies, RequestContext } from '../services/police-context';
import { newPoliceRequest } from '../services/police-context';
import { WantedPersonService } from '../services/wanted.service';
import { WantedCaseService } from '../services/case.service';
import { MatchService } from '../services/match.service';
import { AlertService } from '../services/alert.service';
import { CheckInListService } from '../services/checkin.service';
import { PoliceDashboardService } from '../services/dashboard.service';
import { PoliceAccountService } from '../services/account.service';
import { WantedExportService } from '../services/export.service';
import { attachPoliceMatcherRuntime } from '../worker/police-worker';
import type { PoliceMatcherRuntime } from '../worker/police-worker';

/**
 * The Phase 18 harness: the Phase 08 stay harness — which gives real hotels,
 * rooms, receptionists and check-ins — plus the Police services on the Police
 * login's own pool.
 *
 * Two things it deliberately does not fake.
 *
 * **The Police connection is the Police role.** Every Police service here runs
 * as `prsystem_police`, so a missing grant or a policy that does not admit the
 * realm fails in a test exactly as it would in production, and the isolation
 * doc 13 §3 asks for is measured rather than assumed.
 *
 * **The matcher is the worker's.** Matching runs through the same runtime the
 * worker deployment uses, on the worker login, consuming the same outbox event
 * a real check-in writes.
 */

export interface PoliceActor {
  readonly accountId: string;
  readonly actor: CommandActor;
  readonly email: string;
  readonly unitRef: string;
}

export interface PoliceHarness {
  readonly stay: StayHarness;
  readonly admin: StayHarness['admin'];
  readonly police: Pool;
  readonly deps: PoliceDependencies;
  readonly wanted: WantedPersonService;
  readonly cases: WantedCaseService;
  readonly matches: MatchService;
  readonly alerts: AlertService;
  readonly checkIns: CheckInListService;
  readonly dashboard: PoliceDashboardService;
  readonly accounts: PoliceAccountService;
  readonly exports: WantedExportService;
  readonly matcher: PoliceMatcherRuntime;
  readonly sms: SimulatedSms;
  readonly xyp: SimulatedXypIdentity;
  readonly storage: SimulatedObjectStorage;
  /** A Police account with a role, a unit and the named permissions it needs. */
  officer(options?: {
    role?: PoliceRole;
    unitRef?: string;
    permissions?: readonly string[];
    stepUp?: boolean;
  }): Promise<PoliceActor>;
  /**
   * An approved, verified official number for a Police account (doc 13 §10.2).
   *
   * The real path is a Police Admin provisioning the account, which writes the
   * same row; this is for the accounts a test seeded directly.
   */
  giveContact(accountId: string, phone: string): Promise<string>;
  /** A hotel whose district routes to an approved alert group. */
  hotelInDistrict(name: string, district: string, unitRef: string): Promise<StayHotel>;
  /** A check-in with a registration number, which is what a match is made of. */
  checkIn(
    hotel: StayHotel,
    registrationNumber: string,
    options?: { familyName?: string; givenName?: string },
  ): Promise<{ stayId: string; roomId: string }>;
  advance(minutes: number): void;
  resetClock(): void;
  now(): Date;
  close(): Promise<void>;
}

export async function createPoliceHarness(suite: string): Promise<PoliceHarness> {
  const stay = await createStayHarness(suite);
  let offsetMs = 0;
  const clock = (): Date => new Date(Date.now() + offsetMs);

  const police = new Pool({
    connectionString: stay.db.loginUrl(TEST_LOGIN_PRINCIPALS.police),
    max: 4,
    application_name: 'prsystem_police_test',
  });
  void TEST_LOGIN_PASSWORD;

  // The worker's own login, closed with the harness: a pool left open when the
  // scratch database is dropped is a connection the server has to terminate.
  const workerPool = new Pool({
    connectionString: stay.db.loginUrl(TEST_LOGIN_PRINCIPALS.worker),
    max: 2,
    application_name: 'prsystem_police_matcher_test',
  });

  const sms = new SimulatedSms();
  const xyp = new SimulatedXypIdentity();
  const storage = new SimulatedObjectStorage();
  const deps: PoliceDependencies = {
    pool: police,
    subscription: stay.minibar.catalog.subscription,
    // The *same* key manager the check-in path uses. Matching compares two
    // keyed tokens of one number, so two managers with two seeds would derive
    // two different values and nothing would ever match — which is true in
    // production too, and is why the platform has one KMS and not one per
    // module.
    keys: stay.deps.keys,
    sms,
    xyp,
    storage,
    clock,
  };
  const accounts = new PoliceAccountService(deps, new RepositoryPoliceAccounts());
  let sequence = 0;

  return {
    stay,
    admin: stay.admin,
    police,
    deps,
    wanted: new WantedPersonService(deps),
    cases: new WantedCaseService(deps),
    matches: new MatchService(deps),
    alerts: new AlertService(deps),
    checkIns: new CheckInListService(deps),
    dashboard: new PoliceDashboardService(deps),
    accounts,
    exports: new WantedExportService(deps),
    matcher: attachPoliceMatcherRuntime(workerPool),
    sms,
    xyp,
    storage,

    async officer(options = {}) {
      sequence += 1;
      const role = options.role ?? 'POLICE_OFFICER';
      const unitRef = options.unitRef ?? 'UNIT-A';
      const email = `police-${String(sequence).padStart(3, '0')}-${suite}@police.test`;
      const created = await stay.admin.query<{ account_id: string }>(
        `INSERT INTO platform.user_account
           (realm, realm_role, police_scope_ref, email_normalized, state, email_verified_at)
         VALUES ('police', $1, $2, $3, 'ACTIVE', now())
         RETURNING account_id`,
        [role, unitRef, email],
      );
      const accountId = created.rows[0]?.account_id as string;
      for (const permission of options.permissions ?? []) {
        await stay.admin.query(
          `INSERT INTO platform.account_permission_grant
             (account_id, realm, realm_role, permission, granted_by_account_id)
           VALUES ($1::uuid, 'police', $2, $3, $1::uuid) ON CONFLICT DO NOTHING`,
          [accountId, role, permission],
        );
      }
      // The pipeline re-reads the principal from the database inside every
      // command, so what this fixture supplies is the identity and the step-up
      // recency a fresh sign-in would carry — never the authority itself.
      const actor = {
        principal: {
          accountId,
          realm: 'police' as const,
          accountState: 'ACTIVE' as const,
          memberships: [],
          directPermissions: [...(options.permissions ?? [])],
          realmRole: role,
          policeScopeRef: unitRef,
          // A minute ago rather than this instant: the pipeline compares the
          // recency against the *database's* clock, and a fixture stamped from
          // the host's would be in that clock's future by however much the two
          // differ. A minute is inside doc 05 §5's ten and outside any skew.
          ...(options.stepUp === false ? {} : { stepUpAt: new Date(clock().getTime() - 60_000) }),
        },
        sessionId: undefined as unknown as string,
      } as unknown as CommandActor;
      return { accountId, actor, email, unitRef };
    },

    async giveContact(accountId, phone) {
      const sealed = await encryptValue(deps.keys, 'pii.police', phone, {
        table: 'police.police_contact',
        column: 'phone_ciphertext',
        rowRef: accountId,
      });
      const masked = `****${phone.slice(-4)}`;
      await withTenantTransaction(
        police,
        {
          hotelId: PLATFORM_SCOPE,
          realm: 'police',
          actorRef: 'police-harness',
          correlationId: `harness-contact-${accountId}`,
        },
        async (uow) => {
          await uow.query(
            `UPDATE police.police_contact SET is_current = false
              WHERE account_id = $1::uuid AND is_current`,
            [accountId],
          );
          await uow.query(
            `INSERT INTO police.police_contact
               (account_id, phone_version, is_current, phone_ciphertext, phone_wrapped_dek,
                phone_key_version, phone_masked, verified_at, approved_by_account_id)
             VALUES ($1::uuid, 1, true, $2, $3, $4, $5, now(), $1::uuid)`,
            [
              accountId,
              Buffer.from(sealed.ciphertext),
              Buffer.from(sealed.wrappedDek),
              sealed.keyVersion,
              masked,
            ],
          );
        },
      );
      return masked;
    },

    async hotelInDistrict(name, district, unitRef) {
      const hotel = await stay.hotel(name, 'P30');
      // A check-in needs an open Reception shift, exactly as it does in a real
      // hotel (doc 03 §2).
      await stay.shifts.open(
        { hotelId: hotel.hotelId, idempotencyKey: key('shift'), openingCountedMnt: 0n },
        hotel.reception,
        request(hotel.reception),
      );
      // The public profile is what carries a hotel's district, and doc 13
      // §10.1 routes an alert by exactly that. A hotel provisioned through
      // onboarding always has one; a harness hotel is created without.
      await stay.admin.query(
        `INSERT INTO platform.hotel_profile
           (hotel_id, public_name, public_phone, district, khoroo, address_line,
            latitude_micro, longitude_micro)
         VALUES ($1::uuid, $2, '+97670001122', $3, '1-р хороо', 'Улаанбаатар',
                 47918000, 106917000)
         ON CONFLICT (hotel_id) DO UPDATE
            SET district = EXCLUDED.district, revision = platform.hotel_profile.revision + 1`,
        [hotel.hotelId, name, district],
      );
      await withTenantTransaction(
        police,
        {
          hotelId: PLATFORM_SCOPE,
          realm: 'police',
          actorRef: 'police-harness',
          correlationId: `harness-${district}`,
        },
        async (uow) => {
          const approver = await stay.admin.query<{ account_id: string }>(
            `SELECT account_id FROM platform.user_account
              WHERE realm = 'police' ORDER BY created_at LIMIT 1`,
          );
          await uow.query(
            `INSERT INTO police.district_alert_group (district, unit_ref, approved_by_account_id)
             VALUES ($1, $2, $3::uuid)
             ON CONFLICT (district) DO UPDATE SET unit_ref = EXCLUDED.unit_ref`,
            [district, unitRef, approver.rows[0]?.account_id ?? null],
          );
        },
      );
      return hotel;
    },

    async checkIn(hotel, registrationNumber, options = {}) {
      // The check-in refuses a date of birth that disagrees with the one the
      // number encodes (doc 05 §3), so the fixture derives it rather than
      // asserting a constant that only some numbers happen to satisfy.
      const yy = Number(registrationNumber.slice(2, 4));
      const rawMonth = Number(registrationNumber.slice(4, 6));
      const day = Number(registrationNumber.slice(6, 8));
      const month = rawMonth > 20 ? rawMonth - 20 : rawMonth;
      const year = (rawMonth > 20 ? 2000 : 1900) + yy;
      const dateOfBirth = [
        String(year).padStart(4, '0'),
        String(month).padStart(2, '0'),
        String(day).padStart(2, '0'),
      ].join('-');
      const roomId = await hotel.cleanRoom();
      const checkedIn = await stay.checkIns.checkIn(
        {
          hotelId: hotel.hotelId,
          roomId,
          idempotencyKey: key('ci'),
          source: 'WALK_IN',
          stayType: 'NIGHTLY',
          nightCount: 1,
          guest: {
            identityType: 'MN_REG_NO',
            registrationNumber,
            familyName: options.familyName ?? 'Синтетик',
            givenName: options.givenName ?? 'Зочин',
            dateOfBirth,
            nationality: 'MN',
          } as Parameters<typeof stay.checkIns.checkIn>[0]['guest'],
        },
        hotel.reception,
        request(hotel.reception),
      );
      return { stayId: checkedIn.stayId, roomId };
    },

    advance(minutes) {
      offsetMs = minutes * 60_000;
      stay.travel(minutes);
    },

    resetClock() {
      offsetMs = 0;
      stay.travel(0);
    },

    now: clock,

    async close() {
      await workerPool.end().catch(() => undefined);
      await police.end().catch(() => undefined);
      await stay.close();
    },
  };
}

export { newPoliceRequest, key, request };
export type { RequestContext };
