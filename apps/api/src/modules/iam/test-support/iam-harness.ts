import type { Pool } from 'pg';
import type { HotelRole, PackageCode, Principal } from '@prsystem/authz';
import type { LoginPrincipal } from '@prsystem/db';
import { LOGIN_PRINCIPALS, bootstrapCluster, runMigrations } from '@prsystem/db';
import type { TestDatabase } from '@prsystem/testing';
import {
  TEST_LOGIN_PASSWORD,
  TEST_LOGIN_PRINCIPALS,
  createTestDatabase,
  quietPool,
} from '@prsystem/testing';
import { LocalKeyManagement } from '@prsystem/ports';
import type { AuthSecurityParameters } from '../contracts/security-parameters';
import { AUTH_SECURITY_PARAMETERS } from '../contracts/security-parameters';
import { SimulatedStaffNotification } from '../contracts/staff-notification.port';
import { SimulatedSubscriptionState } from '../contracts/subscription-state.port';
import { SimulatedOpenWork } from '../contracts/open-work.port';
import { SimulatedRestaurantDirectory } from '../contracts/restaurant-directory.port';
import type { CommandActor, IamDependencies } from '../services/iam-context';
import { HandoffService } from '../services/handoff.service';
import { SessionService } from '../services/session.service';
import { StaffService } from '../services/staff.service';
import { derivePassword } from '../services/password.service';
import { newRequestContext } from '../services/iam-context';

/**
 * A real database, the real services, and the two external systems as
 * deterministic simulators.
 *
 * Everything the tests exercise runs through the restricted `prsystem_api`
 * login, so RLS, the grants and the guards are the ones production has. What is
 * *seeded* — the hotel and its Primary Hotel Admin — is written through the
 * administrative connection on purpose: Phase 05 provisions those, no runtime
 * holds INSERT on `platform.hotel`, and a harness that could create a tenant
 * would be proving something the deployment cannot do.
 */

export interface SeededMembership {
  readonly membershipId: string;
  readonly accountId: string;
  readonly email: string;
  readonly password: string;
}

export interface IamHarness {
  readonly db: TestDatabase;
  /** Superuser connection. Seeding and verification only, never an assertion. */
  readonly admin: Pool;
  /** The restricted runtime login every command runs as. */
  readonly api: Pool;
  readonly deps: IamDependencies;
  readonly sessions: SessionService;
  readonly staff: StaffService;
  readonly handoff: HandoffService;
  readonly subscription: SimulatedSubscriptionState;
  readonly notifications: SimulatedStaffNotification;
  /** What the owning modules would report as unfinished work (doc 19 §8). */
  readonly openWork: SimulatedOpenWork;
  /** The hotel → restaurant linkage Phase 15 will own. */
  readonly restaurants: SimulatedRestaurantDirectory;
  /**
   * The live parameter set the services read.
   *
   * Mutable on purpose: a TTL or a resend interval is configuration, and a test
   * that had to wait out the production value would either be slow or would be
   * asserting against a clock it does not control.
   */
  readonly parameters: AuthSecurityParameters;
  createHotel(name: string, packageCode: PackageCode): Promise<string>;
  seedMembership(input: {
    hotelId: string;
    email: string;
    roles: readonly HotelRole[];
    primary?: boolean;
    restaurantId?: string;
    password?: string;
  }): Promise<SeededMembership>;
  close(): Promise<void>;
}

/**
 * The default synthetic passphrase, composed rather than written out for the
 * same reason the fixtures compose theirs: a literal that looks like a
 * credential is what a committed credential looks like.
 */
export const DEFAULT_TEST_PASSWORD = ['synthetic', 'harness', 'passphrase'].join('-');

export interface IamHarnessOverrides {
  /**
   * The simulators the application under test is already using.
   *
   * A test that drives the HTTP surface must reach the *same* instances the
   * running application holds; two would let a test set a subscription the
   * application never sees.
   */
  readonly subscription?: SimulatedSubscriptionState;
  readonly notifications?: SimulatedStaffNotification;
  readonly openWork?: SimulatedOpenWork;
  readonly restaurants?: SimulatedRestaurantDirectory;
  readonly parameters?: AuthSecurityParameters;
}

/** Provisions a scratch database exactly as a deployment does. */
export async function provisionIamDatabase(suite: string): Promise<TestDatabase> {
  const db = await createTestDatabase(suite);
  await bootstrapCluster({
    adminUrl: db.url,
    database: db.name,
    logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
      principal,
      password: TEST_LOGIN_PASSWORD,
    })),
  });
  await runMigrations(db.loginUrl(TEST_LOGIN_PRINCIPALS.migrate));
  return db;
}

export function attachIamHarness(
  db: TestDatabase,
  suite: string,
  overrides: IamHarnessOverrides = {},
): IamHarness {
  const admin = db.pool;
  const api = quietPool({ connectionString: db.loginUrl(TEST_LOGIN_PRINCIPALS.api), max: 8 });
  const subscription = overrides.subscription ?? new SimulatedSubscriptionState();
  const notifications = overrides.notifications ?? new SimulatedStaffNotification();
  const openWork = overrides.openWork ?? new SimulatedOpenWork();
  const restaurants = overrides.restaurants ?? new SimulatedRestaurantDirectory();
  const keys = new LocalKeyManagement({ seed: `iam-harness-${suite}`, appEnv: 'test' });
  const parameters: AuthSecurityParameters = overrides.parameters ?? {
    ...AUTH_SECURITY_PARAMETERS,
  };
  const deps: IamDependencies = {
    pool: api,
    keys,
    subscription,
    notifications,
    openWork,
    restaurants,
    parameters,
  };

  return {
    db,
    admin,
    api,
    deps,
    sessions: new SessionService(deps),
    staff: new StaffService(deps),
    handoff: new HandoffService(deps),
    subscription,
    notifications,
    openWork,
    restaurants,
    parameters,

    async createHotel(name: string, packageCode: PackageCode): Promise<string> {
      const created = await admin.query<{ hotel_id: string }>(
        `INSERT INTO platform.hotel (display_name) VALUES ($1) RETURNING hotel_id`,
        [name],
      );
      const hotelId = created.rows[0]?.hotel_id;
      if (hotelId === undefined) throw new Error('the hotel insert returned no row');
      // Both sources, because from Phase 05 there are two callers with two
      // truths: a service-level test drives the simulator it was handed, while
      // an application booted through `createApp` reads the authoritative row.
      // Seeding one and not the other would make a hotel entitled for half the
      // suite. The row is written on the administrative connection for the same
      // reason the hotel is — no runtime login holds INSERT here, and provisioning
      // it properly is Phase 05's own subject.
      subscription.set(hotelId, { state: 'ACTIVE', effectivePackage: packageCode });
      await admin.query(
        `INSERT INTO platform.hotel_subscription
           (hotel_id, effective_package, package_floor, term_months, starts_at, expires_at)
         VALUES ($1, $2, $2, 12, now(), now() + interval '365 days')`,
        [hotelId, packageCode],
      );
      return hotelId;
    },

    async seedMembership(input): Promise<SeededMembership> {
      const password = input.password ?? DEFAULT_TEST_PASSWORD;
      const email = input.email.toLowerCase();
      const derived = await derivePassword(password);

      const client = await admin.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', ['app.hotel_id', input.hotelId]);
        const account = await client.query<{ account_id: string }>(
          `INSERT INTO platform.user_account (realm, email_normalized, email_verified_at)
           VALUES ('hotel', $1, now())
           ON CONFLICT (realm, email_normalized) DO UPDATE SET realm = EXCLUDED.realm
           RETURNING account_id`,
          [email],
        );
        const accountId = account.rows[0]?.account_id;
        if (accountId === undefined) throw new Error('the account insert returned no row');
        await client.query(
          `INSERT INTO platform.account_credential (account_id, secret_hash, params_version)
           VALUES ($1, $2, $3)
           ON CONFLICT (account_id, kind) DO UPDATE
              SET secret_hash = EXCLUDED.secret_hash, params_version = EXCLUDED.params_version`,
          [accountId, derived.secretHash, derived.paramsVersion],
        );
        const membership = await client.query<{ membership_id: string }>(
          `INSERT INTO platform.staff_membership
             (hotel_id, restaurant_id, account_id, invited_email_normalized, state,
              is_primary_admin, membership_revision, activated_at)
           VALUES ($1, $2, $3, $4, 'ACTIVE', $5, 1, now())
           RETURNING membership_id`,
          [input.hotelId, input.restaurantId ?? null, accountId, email, input.primary === true],
        );
        const membershipId = membership.rows[0]?.membership_id;
        if (membershipId === undefined) throw new Error('the membership insert returned no row');
        for (const role of input.roles) {
          await client.query(
            `INSERT INTO platform.membership_role_grant (hotel_id, membership_id, role)
             VALUES ($1, $2, $3)`,
            [input.hotelId, membershipId, role],
          );
        }
        await client.query('COMMIT');
        return { membershipId, accountId, email, password };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await api.end().catch(() => undefined);
      await db.drop();
    },
  };
}

export async function createIamHarness(
  suite: string,
  overrides: IamHarnessOverrides = {},
): Promise<IamHarness> {
  const db = await provisionIamDatabase(suite);
  return attachIamHarness(db, suite, overrides);
}

/**
 * The actor a command runs as, resolved exactly the way the guard resolves it.
 *
 * A real sign-in, then a real authentication: that is what issues the session's
 * per-hotel scope grants, and a test that fabricated a principal instead would
 * be exercising a path no request can take.
 */
export async function actorFor(
  harness: IamHarness,
  member: SeededMembership,
): Promise<CommandActor> {
  const signedIn = await harness.sessions.signIn(
    member.email,
    member.password,
    newRequestContext(),
  );
  const session = await harness.sessions.authenticate(signedIn.token, newRequestContext());
  return { principal: session.principal, sessionId: session.sessionId };
}

/** The principal alone, for the assertions that only look at identity. */
export async function principalFor(
  harness: IamHarness,
  member: SeededMembership,
): Promise<Principal> {
  return (await actorFor(harness, member)).principal;
}
