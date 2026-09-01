import type { Pool } from 'pg';
import type { TestDatabase } from '@prsystem/testing';
import { TEST_LOGIN_PRINCIPALS, quietPool } from '@prsystem/testing';
import { LocalKeyManagement } from '@prsystem/ports';
import { provisionIamDatabase } from '../../iam/test-support/iam-harness';
import { SimulatedStaffNotification } from '../../iam/contracts/staff-notification.port';
import type { OnboardingParameters } from '../contracts/onboarding-parameters';
import { ONBOARDING_PARAMETERS } from '../contracts/onboarding-parameters';
import type { PaymentProvider } from '../contracts/payment-gateway.port';
import { PaymentGatewayRegistry, SimulatedPaymentGateway } from '../contracts/payment-gateway.port';
import { SimulatedEBarimt } from '../contracts/ebarimt.port';
import { SimulatedPhoneVerification } from '../contracts/phone-verification.port';
import { DatabaseSubscriptionState } from '../contracts/subscription-state.adapter';
import type { OnboardingDependencies } from '../services/onboarding-context';
import { OnboardingService } from '../services/onboarding.service';
import { ProvisioningService } from '../services/provisioning.service';
import { ActivationService } from '../services/activation.service';
import { SubscriptionService } from '../services/subscription.service';
import { EBarimtService } from '../services/ebarimt.service';

/**
 * A real database, the real services, and every external system as a
 * deterministic simulator.
 *
 * Everything runs through the restricted `prsystem_api` login, so the RLS
 * policies, the grants, the guards and the provisioning boundary are the ones
 * production has. Nothing here seeds a hotel: Phase 05's whole subject is that a
 * hotel comes into existence only through a paid application, and a harness that
 * could create one would be proving something the deployment cannot do.
 */

export interface OnboardingHarness {
  readonly db: TestDatabase;
  /** Superuser connection. Verification only, never an assertion's subject. */
  readonly admin: Pool;
  /** The restricted runtime login every command runs as. */
  readonly api: Pool;
  readonly deps: OnboardingDependencies;
  readonly onboarding: OnboardingService;
  readonly provisioning: ProvisioningService;
  readonly activation: ActivationService;
  readonly subscriptions: SubscriptionService;
  readonly ebarimt: EBarimtService;
  readonly gateways: PaymentGatewayRegistry;
  readonly qpay: SimulatedPaymentGateway;
  readonly khaan: SimulatedPaymentGateway;
  readonly receipts: SimulatedEBarimt;
  readonly phone: SimulatedPhoneVerification;
  readonly notifications: SimulatedStaffNotification;
  /** The authoritative port, so a test can assert what authorization would see. */
  readonly subscriptionState: DatabaseSubscriptionState;
  /** Mutable: a TTL or a retry cap is configuration, and a test drives it. */
  readonly parameters: OnboardingParameters;
  close(): Promise<void>;
}

export function attachOnboardingHarness(db: TestDatabase, suite: string): OnboardingHarness {
  const admin = db.pool;
  const api = quietPool({ connectionString: db.loginUrl(TEST_LOGIN_PRINCIPALS.api), max: 8 });
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
  const notifications = new SimulatedStaffNotification();
  const keys = new LocalKeyManagement({ seed: `onboarding-harness-${suite}`, appEnv: 'test' });
  const parameters: OnboardingParameters = { ...ONBOARDING_PARAMETERS };

  const deps: OnboardingDependencies = {
    pool: api,
    keys,
    gateways,
    ebarimt: receipts,
    phone,
    notifications,
    parameters,
  };

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
    gateways,
    qpay,
    khaan,
    receipts,
    phone,
    notifications,
    subscriptionState: new DatabaseSubscriptionState(api),
    parameters,
    async close(): Promise<void> {
      await api.end().catch(() => undefined);
      await db.drop();
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
