import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import type { Principal } from '@prsystem/authz';
import {
  LocalKeyManagement,
  SimulatedNotification,
  SimulatedSms,
  encryptValue,
} from '@prsystem/ports';
import { TEST_LOGIN_PRINCIPALS, quietPool } from '@prsystem/testing';
import type { TestDatabase } from '@prsystem/testing';
import type { IamHarness, SeededMembership } from '../../iam/test-support/iam-harness';
import { attachIamHarness, provisionIamDatabase } from '../../iam/test-support/iam-harness';
import { DatabaseSubscriptionState } from '../../onboarding/contracts/subscription-state.adapter';
import { RepositoryOperationAccounts } from '../../iam/contracts/operation-accounts';
import { derivePassword } from '../../iam/services/password.service';
import { TokenService, SESSION_TOKEN_SUBJECT } from '../../iam/services/token.service';
import type { OperationDependencies, CommandActor } from '../services/operation-context';
import { OperationAuthService } from '../services/auth.service';
import { OperationAccessService } from '../services/access.service';
import { OperationDashboardService } from '../services/dashboard.service';
import { OperationSubscriptionService } from '../services/subscription.service';
import { OperationRecoveryService } from '../services/recovery.service';
import { SubscriptionContactService } from '../services/contact.service';
import { OperationSmsService } from '../services/sms.service';
import type { OperationParameters } from '../contracts/operation-parameters';
import { OPERATION_PARAMETERS } from '../contracts/operation-parameters';
import { base32Encode, totpCode, totpStep } from '../domain/operation';

/**
 * The Phase 19 fixtures.
 *
 * Two decisions shape it. Operation accounts are minted with a **real** TOTP
 * factor, sealed with the same key port the services use, so a test signs in
 * and steps up the way a person would rather than writing a `step_up_at` by
 * hand. And a provisioned hotel is seeded through the rows a real provisioning
 * writes — profile, owner link, application, activation, subscription — so the
 * dashboard's resolvers, its masking and the contact seed trigger are all
 * exercised rather than bypassed.
 */

export const OPERATION_PASSWORD = ['synthetic', 'operation', 'passphrase'].join('-');
export const HOTEL_ADMIN_PASSWORD = ['synthetic', 'hotel-admin', 'passphrase'].join('-');

export interface SeededOperator {
  readonly accountId: string;
  readonly email: string;
  readonly actor: CommandActor;
  readonly token: string;
  readonly sessionId: string;
  /** The code an authenticator would show at `at`. */
  codeAt(at?: Date): string;
}

export interface SeededHotel {
  readonly hotelId: string;
  readonly subscriptionId: string;
  readonly name: string;
  readonly district: string;
  readonly contactPhone: string;
  /** The Primary Hotel Admin, ready for `actorFor`. */
  readonly admin: SeededMembership;
}

export interface OperationHarness {
  readonly db: TestDatabase;
  readonly admin: Pool;
  readonly api: Pool;
  readonly deps: OperationDependencies;
  readonly iam: IamHarness;
  readonly keys: LocalKeyManagement;
  readonly sms: SimulatedSms;
  readonly notifications: SimulatedNotification;
  readonly parameters: OperationParameters;
  readonly auth: OperationAuthService;
  readonly access: OperationAccessService;
  readonly dashboard: OperationDashboardService;
  readonly subscriptions: OperationSubscriptionService;
  readonly recovery: OperationRecoveryService;
  readonly contacts: SubscriptionContactService;
  readonly smsService: OperationSmsService;
  operator(input: {
    role?: 'OPERATION_ADMIN' | 'PLATFORM_SUPER_ADMIN';
    permissions: readonly string[];
    stepUpAgeSeconds?: number;
  }): Promise<SeededOperator>;
  hotel(input?: {
    name?: string;
    district?: string;
    packageCode?: 'P20' | 'P25' | 'P30';
    termMonths?: 1 | 3 | 7 | 12;
    /** Hours from now. Negative puts the subscription past its expiry. */
    expiresInHours?: number;
    suspended?: boolean;
    contactPhone?: string;
    ownerType?: 'CITIZEN' | 'ORGANIZATION';
  }): Promise<SeededHotel>;
  /** An unprovisioned or paid-not-provisioned application, for the queue. */
  application(state: string): Promise<string>;
  close(): Promise<void>;
}

let sequence = 0;

export async function createOperationHarness(suite: string): Promise<OperationHarness> {
  const db = await provisionIamDatabase(suite);
  return attachOperationHarness(db, suite);
}

export function attachOperationHarness(
  db: TestDatabase,
  suite: string,
  options: { keySeed?: string; iam?: IamHarness } = {},
): OperationHarness {
  const admin = db.pool;
  const api = quietPool({ connectionString: db.loginUrl(TEST_LOGIN_PRINCIPALS.api), max: 8 });
  const iam = options.iam ?? attachIamHarness(db, suite);
  const keys = new LocalKeyManagement({
    seed: options.keySeed ?? `operation-harness-${suite}`,
    appEnv: 'test',
  });
  const sms = new SimulatedSms();
  const notifications = new SimulatedNotification();
  const parameters: OperationParameters = { ...OPERATION_PARAMETERS };
  const accounts = new RepositoryOperationAccounts();
  const deps: OperationDependencies = {
    pool: api,
    accounts,
    subscription: new DatabaseSubscriptionState(api),
    keys,
    sms,
    notifications,
    parameters,
  };
  const tokens = new TokenService(keys);

  return {
    db,
    admin,
    api,
    deps,
    iam,
    keys,
    sms,
    notifications,
    parameters,
    auth: new OperationAuthService(deps),
    access: new OperationAccessService(deps),
    dashboard: new OperationDashboardService(deps),
    subscriptions: new OperationSubscriptionService(deps),
    recovery: new OperationRecoveryService(deps),
    contacts: new SubscriptionContactService(deps),
    smsService: new OperationSmsService(deps),

    async operator(input): Promise<SeededOperator> {
      sequence += 1;
      const role = input.role ?? 'OPERATION_ADMIN';
      const email = `operator-${String(sequence).padStart(4, '0')}@operation.test`;
      const created = await admin.query<{ account_id: string }>(
        `INSERT INTO platform.user_account
           (realm, realm_role, email_normalized, state, email_verified_at)
         VALUES ('operation', $1, $2, 'ACTIVE', now())
         RETURNING account_id`,
        [role, email],
      );
      const accountId = created.rows[0]?.account_id as string;

      const derived = await derivePassword(OPERATION_PASSWORD);
      await admin.query(
        `INSERT INTO platform.account_credential (account_id, secret_hash, params_version)
         VALUES ($1::uuid, $2, $3)`,
        [accountId, derived.secretHash, derived.paramsVersion],
      );

      // A real factor, sealed exactly as the enrolment seals one, so a test can
      // present a code the service will accept.
      const secret = randomBytes(20);
      const sealed = await encryptValue(keys, 'auth.operation_totp', secret.toString('base64'), {
        table: 'platform.operation_totp_factor',
        column: 'secret_ciphertext',
        rowRef: accountId,
      });
      await admin.query(
        `INSERT INTO platform.operation_totp_factor
           (account_id, secret_ciphertext, secret_wrapped_dek, secret_key_version)
         VALUES ($1::uuid, $2, $3, $4)`,
        [
          accountId,
          Buffer.from(sealed.ciphertext),
          Buffer.from(sealed.wrappedDek),
          sealed.keyVersion,
        ],
      );

      for (const permission of input.permissions) {
        await admin.query(
          `INSERT INTO platform.account_permission_grant
             (account_id, realm, realm_role, permission, granted_by_account_id)
           VALUES ($1, 'operation', $2, $3, $1)`,
          [accountId, role, permission],
        );
      }

      const issued = await tokens.issue('session', SESSION_TOKEN_SUBJECT);
      const stepUpAge = input.stepUpAgeSeconds ?? 0;
      const session = await admin.query<{ session_id: string; step_up_at: Date }>(
        `INSERT INTO platform.server_session
           (account_id, realm, token_hash, token_key_version, account_epoch,
            idle_expires_at, absolute_expires_at, step_up_at)
         VALUES ($1, 'operation', $2, $3, 0, now() + interval '30 minutes',
                 now() + interval '8 hours', now() - make_interval(secs => $4))
         RETURNING session_id, step_up_at`,
        [accountId, issued.tokenHash, issued.keyVersion, stepUpAge],
      );
      const principal: Principal = {
        accountId,
        realm: 'operation',
        accountState: 'ACTIVE',
        memberships: [],
        directPermissions: [...input.permissions],
        realmRole: role,
        stepUpAt: session.rows[0]?.step_up_at as Date,
      };
      return {
        accountId,
        email,
        actor: { principal, sessionId: session.rows[0]?.session_id as string },
        token: issued.token,
        sessionId: session.rows[0]?.session_id as string,
        codeAt: (at = new Date()) => totpCode(secret, totpStep(at)),
      };
    },

    async hotel(input = {}): Promise<SeededHotel> {
      sequence += 1;
      const suffix = String(sequence).padStart(4, '0');
      const name = input.name ?? `Буудал ${suffix}`;
      const district = input.district ?? 'Баянгол';
      const packageCode = input.packageCode ?? 'P20';
      const termMonths = input.termMonths ?? 1;
      const ownerType = input.ownerType ?? 'CITIZEN';
      const contactPhone = input.contactPhone ?? `+9769${suffix}${suffix.slice(0, 3)}`;
      const adminEmail = `admin-${suffix}@hotel.test`;

      const hotel = await admin.query<{ hotel_id: string }>(
        `INSERT INTO platform.hotel (display_name) VALUES ($1) RETURNING hotel_id`,
        [name],
      );
      const hotelId = hotel.rows[0]?.hotel_id as string;

      await admin.query(
        `INSERT INTO platform.hotel_profile
           (hotel_id, public_name, public_phone, district, khoroo, address_line,
            latitude_micro, longitude_micro, listing_state)
         VALUES ($1, $2, $3, $4, '1-р хороо', 'Синтетик хаяг', 47918000, 106917000, 'PUBLISHED')`,
        [hotelId, name, contactPhone, district],
      );

      const owner = await admin.query<{ owner_id: string }>(
        `INSERT INTO platform.subscription_owner
           (owner_type, display_name, representative_name, representative_position,
            identity_type, identifier_ciphertext, identifier_wrapped_dek, identifier_key_version,
            identifier_lookup_token, identifier_lookup_key_version)
         VALUES ($1, $2,
                 CASE WHEN $1 = 'ORGANIZATION' THEN 'Төлөөлөгч' ELSE NULL END,
                 CASE WHEN $1 = 'ORGANIZATION' THEN 'Захирал' ELSE NULL END,
                 'registration_number', '\\x00'::bytea, '\\x00'::bytea, 'v1',
                 encode(digest($3, 'sha256'), 'hex'), 'v1')
         RETURNING owner_id`,
        [ownerType, `Эзэмшигч ${suffix}`, `owner-${suffix}`],
      );
      const ownerId = owner.rows[0]?.owner_id as string;

      const application = await admin.query<{ application_id: string }>(
        `INSERT INTO platform.onboarding_application
           (state, owner_type, applicant_token_hash, applicant_token_key_version,
            owner_display_name, representative_name, representative_position,
            owner_identifier_ciphertext, owner_identifier_wrapped_dek,
            owner_identifier_key_version, owner_identifier_lookup_token,
            owner_identifier_lookup_key_version,
            contact_phone, subscription_contact_phone, admin_email_normalized,
            hotel_display_name, hotel_public_phone, district, khoroo, address_line,
            latitude_micro, longitude_micro,
            package_code, term_months, monthly_price_mnt, total_amount_mnt, vat_rate_bp,
            price_book_version, tax_config_version, package_feature_version,
            owner_id, provisioned_hotel_id, paid_attempt_id, payment_confirmed_at)
         VALUES ('PROVISIONED', $1, encode(digest($2, 'sha256'), 'hex'), 'v1',
                 $3,
                 CASE WHEN $1 = 'ORGANIZATION' THEN 'Төлөөлөгч' ELSE NULL END,
                 CASE WHEN $1 = 'ORGANIZATION' THEN 'Захирал' ELSE NULL END,
                 '\\x00'::bytea, '\\x00'::bytea, 'v1',
                 encode(digest($2, 'sha256'), 'hex'), 'v1',
                 $4, $4, $5, $6, $4, $7, '1-р хороо', 'Синтетик хаяг', 47918000, 106917000,
                 $8, $9,
                 CASE $8 WHEN 'P20' THEN 20000 WHEN 'P25' THEN 25000 ELSE 30000 END,
                 CASE $8 WHEN 'P20' THEN 20000 WHEN 'P25' THEN 25000 ELSE 30000 END * $9,
                 1000, 'pb-1', 'tax-1', 'pkg-1', $10::uuid, $11::uuid,
                 gen_random_uuid(), now())
         RETURNING application_id`,
        [
          ownerType,
          `app-${suffix}`,
          `Эзэмшигч ${suffix}`,
          contactPhone,
          adminEmail,
          name,
          district,
          packageCode,
          termMonths,
          ownerId,
          hotelId,
        ],
      );
      const applicationId = application.rows[0]?.application_id as string;

      await admin.query(
        `INSERT INTO platform.hotel_owner_link (hotel_id, owner_id, owner_type, application_id)
         VALUES ($1, $2, $3, $4)`,
        [hotelId, ownerId, ownerType, applicationId],
      );

      const account = await admin.query<{ account_id: string }>(
        `INSERT INTO platform.user_account (realm, email_normalized, state, email_verified_at)
         VALUES ('hotel', $1, 'ACTIVE', now()) RETURNING account_id`,
        [adminEmail],
      );
      const adminAccountId = account.rows[0]?.account_id as string;
      const adminSecret = await derivePassword(HOTEL_ADMIN_PASSWORD);
      await admin.query(
        `INSERT INTO platform.account_credential (account_id, secret_hash, params_version)
         VALUES ($1::uuid, $2, $3)`,
        [adminAccountId, adminSecret.secretHash, adminSecret.paramsVersion],
      );
      const membership = await admin.query<{ membership_id: string }>(
        `INSERT INTO platform.staff_membership
           (hotel_id, account_id, invited_email_normalized, state, is_primary_admin,
            membership_revision, activated_at)
         VALUES ($1, $2, $3, 'ACTIVE', true, 1, now())
         RETURNING membership_id`,
        [hotelId, adminAccountId, adminEmail],
      );
      await admin.query(
        `INSERT INTO platform.membership_role_grant
           (hotel_id, membership_id, role, granted_by_account_id)
         VALUES ($1, $2, 'HOTEL_ADMIN', $3)`,
        [hotelId, membership.rows[0]?.membership_id, adminAccountId],
      );
      await admin.query(
        `INSERT INTO platform.hotel_admin_activation
           (hotel_id, membership_id, account_id, application_id, state, email_normalized,
            activated_at)
         VALUES ($1, $2, $3, $4, 'ACTIVE', $5, now())`,
        [hotelId, membership.rows[0]?.membership_id, adminAccountId, applicationId, adminEmail],
      );

      const expiresInHours = input.expiresInHours ?? 24 * 90;
      const subscription = await admin.query<{ subscription_id: string }>(
        `INSERT INTO platform.hotel_subscription
           (hotel_id, effective_package, package_floor, term_months, starts_at, expires_at,
            suspended_at, suspension_reason)
         VALUES ($1, $2, $2, $3,
                 least(now() - interval '1 day',
                       now() + make_interval(hours => $4) - interval '1 day'),
                 now() + make_interval(hours => $4),
                 CASE WHEN $5 THEN now() ELSE NULL END,
                 CASE WHEN $5 THEN 'FIXTURE_SUSPENSION' ELSE NULL END)
         RETURNING subscription_id`,
        [hotelId, packageCode, termMonths, expiresInHours, input.suspended ?? false],
      );

      return {
        hotelId,
        subscriptionId: subscription.rows[0]?.subscription_id as string,
        name,
        district,
        contactPhone,
        admin: {
          membershipId: membership.rows[0]?.membership_id as string,
          accountId: adminAccountId,
          email: adminEmail,
          password: HOTEL_ADMIN_PASSWORD,
        },
      };
    },

    async application(state): Promise<string> {
      sequence += 1;
      const suffix = String(sequence).padStart(4, '0');
      const paid = [
        'PAID_PENDING_PROVISIONING',
        'PROVISIONING',
        'PROVISIONING_FAILED',
        'PAID_OWNER_VERIFICATION_REQUIRED',
      ].includes(state);
      const created = await admin.query<{ application_id: string }>(
        `INSERT INTO platform.onboarding_application
           (state, owner_type, applicant_token_hash, applicant_token_key_version,
            owner_display_name, owner_identifier_ciphertext, owner_identifier_wrapped_dek,
            owner_identifier_key_version, owner_identifier_lookup_token,
            owner_identifier_lookup_key_version,
            contact_phone, subscription_contact_phone, admin_email_normalized,
            hotel_display_name, hotel_public_phone, district, khoroo, address_line,
            latitude_micro, longitude_micro,
            package_code, term_months, monthly_price_mnt, total_amount_mnt, vat_rate_bp,
            price_book_version, tax_config_version, package_feature_version,
            paid_attempt_id, payment_confirmed_at)
         VALUES ($1, 'CITIZEN', encode(digest($2, 'sha256'), 'hex'), 'v1',
                 $3, '\\x00'::bytea, '\\x00'::bytea, 'v1',
                 encode(digest($2, 'sha256'), 'hex'), 'v1',
                 '+97699001122', '+97699001122', $4, $5, '+97699001122', 'Хан-Уул',
                 '2-р хороо', 'Синтетик хаяг', 47918000, 106917000,
                 'P20', 1, 20000, 20000, 1000, 'pb-1', 'tax-1', 'pkg-1',
                 CASE WHEN $6 THEN gen_random_uuid() ELSE NULL END,
                 CASE WHEN $6 THEN now() ELSE NULL END)
         RETURNING application_id`,
        [
          state,
          `queue-${suffix}`,
          `Эзэмшигч ${suffix}`,
          `queue-${suffix}@hotel.test`,
          `Хүлээгдэж ${suffix}`,
          paid,
        ],
      );
      return created.rows[0]?.application_id as string;
    },

    async close(): Promise<void> {
      await api.end().catch(() => undefined);
      if (options.iam === undefined) await iam.close();
      else await db.drop();
    },
  };
}

/** The base32 form of a secret, for a test that asserts what an enrolment returns. */
export { base32Encode };
