import type { Pool } from 'pg';
import type { TestDatabase } from '@prsystem/testing';
import { TEST_LOGIN_PRINCIPALS, quietPool } from '@prsystem/testing';
import type { Principal } from '@prsystem/authz';
import { LocalKeyManagement } from '@prsystem/ports';
import type { PaymentProvider, SimulatedStaffNotification } from '@prsystem/ports';
import {
  PaymentGatewayRegistry,
  SimulatedEBarimt,
  SimulatedPaymentGateway,
  SimulatedPhoneVerification,
} from '@prsystem/ports';
import type { IamHarness } from '../../iam/test-support/iam-harness';
import { attachIamHarness, provisionIamDatabase } from '../../iam/test-support/iam-harness';
import { SESSION_TOKEN_SUBJECT, TokenService } from '../../iam/services/token.service';
import type { CommandActor } from '../../iam/services/iam-context';
import type { OnboardingParameters } from '../contracts/onboarding-parameters';
import { ONBOARDING_PARAMETERS } from '../contracts/onboarding-parameters';
import { RecordingProvisioningSignal } from '../contracts/provisioning-signal';
import { DatabaseSubscriptionState } from '../contracts/subscription-state.adapter';
import type { OnboardingDependencies } from '../services/onboarding-context';
import { OnboardingService } from '../services/onboarding.service';
import { ProvisioningService } from '../services/provisioning.service';
import { ActivationService } from '../services/activation.service';
import { SubscriptionService } from '../services/subscription.service';
import { EBarimtService } from '../services/ebarimt.service';
import { attachOnboardingWorkerRuntime } from '../worker/onboarding-worker';
import type { OnboardingWorkerRuntime } from '../worker/onboarding-worker';

/**
 * A real database, the real services, and every external system as a
 * deterministic simulator.
 *
 * Everything runs through the restricted `prsystem_api` login — and the worker
 * runtime through the restricted `prsystem_worker` login — so the RLS policies,
 * the grants, the guards and the provisioning boundary are the ones production
 * has. Nothing here seeds a hotel through the onboarding tables: Phase 05's
 * whole subject is that a hotel comes into existence only through a paid
 * application. The IAM harness seeds hotels for *other* purposes — a Hotel
 * Admin elsewhere, a stranger's session — exactly as Phase 04's tests do.
 */

export interface OperationActorOptions {
  readonly role?: 'OPERATION_ADMIN' | 'PLATFORM_SUPER_ADMIN';
  readonly permissions: readonly string[];
  /** How long ago the step-up happened. Zero means just now. */
  readonly stepUpAgeSeconds?: number;
}

export interface OperationActor {
  readonly actor: CommandActor;
  /** The bearer a request presents. Digested with the harness's own keys. */
  readonly token: string;
  readonly accountId: string;
}

export interface OnboardingHarness {
  readonly db: TestDatabase;
  /** Superuser connection. Verification only, never an assertion's subject. */
  readonly admin: Pool;
  /** The restricted runtime login every API command runs as. */
  readonly api: Pool;
  readonly deps: OnboardingDependencies;
  readonly onboarding: OnboardingService;
  readonly provisioning: ProvisioningService;
  readonly activation: ActivationService;
  readonly subscriptions: SubscriptionService;
  readonly ebarimt: EBarimtService;
  /** The Phase 05 background operations, on the worker's own login. */
  readonly worker: OnboardingWorkerRuntime;
  /** The worker deployment's own restricted login, for direct boundary probes. */
  readonly workerDb: Pool;
  /** The Phase 04 harness on the same database, sharing the notification simulator. */
  readonly iam: IamHarness;
  readonly gateways: PaymentGatewayRegistry;
  readonly qpay: SimulatedPaymentGateway;
  readonly khaan: SimulatedPaymentGateway;
  readonly receipts: SimulatedEBarimt;
  readonly phone: SimulatedPhoneVerification;
  readonly notifications: SimulatedStaffNotification;
  readonly signals: RecordingProvisioningSignal;
  readonly keys: LocalKeyManagement;
  /** The authoritative port, so a test can assert what authorization would see. */
  readonly subscriptionState: DatabaseSubscriptionState;
  /** Mutable: a TTL or a retry cap is configuration, and a test drives it. */
  readonly parameters: OnboardingParameters;
  /** An Operation-realm account with explicit grants and a live, stepped-up session. */
  operationActor(options: OperationActorOptions): Promise<OperationActor>;
  close(): Promise<void>;
}

export interface OnboardingHarnessOptions {
  /**
   * The key-management seed. A test that boots the real application passes the
   * seed the application runs on, so a session this harness mints verifies
   * over HTTP.
   */
  readonly keySeed?: string;
  /** An IAM harness already attached to the same database. */
  readonly iam?: IamHarness;
}

let operationSequence = 0;

export function attachOnboardingHarness(
  db: TestDatabase,
  suite: string,
  options: OnboardingHarnessOptions = {},
): OnboardingHarness {
  const admin = db.pool;
  const api = quietPool({ connectionString: db.loginUrl(TEST_LOGIN_PRINCIPALS.api), max: 8 });
  const workerPool = quietPool({
    connectionString: db.loginUrl(TEST_LOGIN_PRINCIPALS.worker),
    max: 4,
  });
  const qpay = new SimulatedPaymentGateway('QPAY');
  const khaan = new SimulatedPaymentGateway('KHAAN');
  const gateways = new PaymentGatewayRegistry(
    new Map<PaymentProvider, SimulatedPaymentGateway>([
      ['QPAY', qpay],
      ['KHAAN', khaan],
    ]),
  );
  const receipts = new SimulatedEBarimt();
  const phone = new SimulatedPhoneVerification();
  const iam = options.iam ?? attachIamHarness(db, suite);
  const notifications = iam.notifications;
  const signals = new RecordingProvisioningSignal();
  const keys = new LocalKeyManagement({
    seed: options.keySeed ?? `onboarding-harness-${suite}`,
    appEnv: 'test',
  });
  const parameters: OnboardingParameters = { ...ONBOARDING_PARAMETERS };

  const deps: OnboardingDependencies = {
    pool: api,
    keys,
    gateways,
    ebarimt: receipts,
    phone,
    notifications,
    signals,
    parameters,
  };
  const tokens = new TokenService(keys);

  return {
    db,
    admin,
    api,
    deps,
    onboarding: new OnboardingService(deps),
    provisioning: new ProvisioningService(deps),
    activation: new ActivationService(deps),
    subscriptions: new SubscriptionService(deps),
    ebarimt: new EBarimtService(deps),
    worker: attachOnboardingWorkerRuntime({ ...deps, pool: workerPool }),
    workerDb: workerPool,
    iam,
    gateways,
    qpay,
    khaan,
    receipts,
    phone,
    notifications,
    signals,
    keys,
    subscriptionState: new DatabaseSubscriptionState(api),
    parameters,

    async operationActor(input): Promise<OperationActor> {
      operationSequence += 1;
      const role = input.role ?? 'OPERATION_ADMIN';
      const email = `operator-${String(operationSequence).padStart(4, '0')}@operation.test`;
      const created = await admin.query<{ account_id: string }>(
        `INSERT INTO platform.user_account (realm, realm_role, email_normalized, email_verified_at)
         VALUES ('operation', $1, $2, now()) RETURNING account_id`,
        [role, email],
      );
      const accountId = created.rows[0]?.account_id as string;
      for (const permission of input.permissions) {
        await admin.query(
          `INSERT INTO platform.account_permission_grant
             (account_id, realm, realm_role, permission, granted_by_account_id)
           VALUES ($1, 'operation', $2, $3, $1)`,
          [accountId, role, permission],
        );
      }
      // A real session row, minted the way sign-in mints one. The MVP has no
      // Operation sign-in yet (Phase 19), so the row is written directly; what
      // the pipeline then reads — the epoch, the step-up instant, the grants —
      // is exactly what a production session would carry.
      const issued = await tokens.issue('session', SESSION_TOKEN_SUBJECT);
      const stepUpAge = input.stepUpAgeSeconds ?? 0;
      const session = await admin.query<{ session_id: string; step_up_at: Date }>(
        `INSERT INTO platform.server_session
           (account_id, realm, token_hash, token_key_version, account_epoch,
            idle_expires_at, absolute_expires_at, step_up_at)
         VALUES ($1, 'operation', $2, $3, 0, now() + interval '1 hour', now() + interval '8 hours',
                 now() - make_interval(secs => $4))
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
        actor: { principal, sessionId: session.rows[0]?.session_id as string },
        token: issued.token,
        accountId,
      };
    },

    async close(): Promise<void> {
      await workerPool.end().catch(() => undefined);
      await api.end().catch(() => undefined);
      if (options.iam === undefined) await iam.close();
      else await db.drop();
    },
  };
}

export async function createOnboardingHarness(suite: string): Promise<OnboardingHarness> {
  const db = await provisionIamDatabase(suite);
  return attachOnboardingHarness(db, suite);
}

/** A complete, synthetic citizen application. Never a real identifier. */
export function citizenDraft(overrides: Partial<Record<string, unknown>> = {}): {
  ownerType: 'CITIZEN';
  ownerDisplayName: string;
  registrationNumber: string;
  contactPhone: string;
  subscriptionContactPhone: string;
  adminEmail: string;
  hotelDisplayName: string;
  hotelPublicPhone: string;
  district: string;
  khoroo: string;
  addressLine: string;
  latitudeMicro: number;
  longitudeMicro: number;
  packageCode: string;
  termMonths: number;
} {
  return {
    ownerType: 'CITIZEN',
    ownerDisplayName: 'Synthetic Applicant',
    // Synthetic by construction: composed rather than written out, so nothing
    // that looks like a real Mongolian registration number is committed.
    registrationNumber: ['SYN', '99', '0022'].join(''),
    contactPhone: '+97699000001',
    subscriptionContactPhone: '+97699000001',
    adminEmail: 'synthetic-owner@example.test',
    hotelDisplayName: 'Synthetic Hotel',
    hotelPublicPhone: '+97611000001',
    district: 'Sukhbaatar',
    khoroo: '1-r khoroo',
    addressLine: 'Synthetic address 1',
    latitudeMicro: 47_918_000,
    longitudeMicro: 106_917_000,
    packageCode: 'P20',
    termMonths: 1,
    ...overrides,
  } as ReturnType<typeof citizenDraft>;
}

export function organizationDraft(overrides: Partial<Record<string, unknown>> = {}): ReturnType<
  typeof citizenDraft
> & {
  representativeName: string;
  representativePosition: string;
} {
  return {
    ...citizenDraft({
      ownerType: 'ORGANIZATION',
      ownerDisplayName: 'Synthetic LLC',
      registrationNumber: ['SYN', '77', '0033'].join(''),
      adminEmail: 'synthetic-org@example.test',
      hotelDisplayName: 'Synthetic Org Hotel',
      addressLine: 'Synthetic address 2',
      ...overrides,
    }),
    representativeName: 'Synthetic Representative',
    representativePosition: 'Director',
  } as ReturnType<typeof organizationDraft>;
}
