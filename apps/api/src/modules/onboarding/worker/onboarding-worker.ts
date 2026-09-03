import { Pool } from 'pg';
import { selectKeyManagement } from '@prsystem/ports';
import type { KeyManagementPort } from '@prsystem/ports';
import {
  selectEBarimt,
  selectPaymentGateways,
  selectPhoneVerification,
  selectStaffNotification,
} from '@prsystem/ports';
import type { OnboardingParameters } from '../contracts/onboarding-parameters';
import { NoProvisioningSignal } from '../contracts/provisioning-signal';
import type { OnboardingDependencies } from '../services/onboarding-context';
import { EBarimtService } from '../services/ebarimt.service';
import { ProvisioningService } from '../services/provisioning.service';
import type { ProvisioningOutcome, SweepOutcome } from '../services/provisioning.service';
import { SubscriptionService } from '../services/subscription.service';

/**
 * The Phase 05 background operations, as the worker deployment runs them
 * (R3, R5; doc 15 §5, doc 16 §4.1, doc 17 §4.4).
 *
 * Four operations, one runtime. Each is the very method the API-side service
 * exposes — the worker does not re-implement provisioning, it runs it — bound
 * to the worker's own restricted database login and to the ports the
 * environment selects. Every operation is idempotent and sweep-shaped: it finds
 * what is due in PostgreSQL, claims it by compare-and-set, and settles it the
 * same way. A Redis message only says "look now".
 */
export interface OnboardingWorkerRuntime {
  /** Claims and runs every provisioning job that is due (R3). */
  provisionDue(limit?: number): Promise<SweepOutcome>;
  /** One application, from a signal. */
  provisionOne(applicationId: string): Promise<ProvisioningOutcome>;
  /** Delivers the first Hotel Admin's activation links (doc 15 §5). */
  deliverActivations(limit?: number): Promise<number>;
  /** Issues and retries eBarimt receipts (doc 16 §4.1). */
  issueReceipts(limit?: number): Promise<number>;
  /** Applies paid pending upgrades at their boundary (doc 17 §4.4). */
  applyUpgradeBoundaries(limit?: number): Promise<number>;
  close(): Promise<void>;
}

export interface OnboardingWorkerConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
  readonly kmsAdapter: string;
  readonly kmsSeed?: string;
  readonly parameters?: OnboardingParameters;
}

/** Builds the runtime from configuration, selecting the environment's ports. */
export function createOnboardingWorkerRuntime(
  config: OnboardingWorkerConfig,
): OnboardingWorkerRuntime {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 6 });
  const keys = selectKeyManagement({
    appEnv: config.appEnv,
    kmsAdapter: config.kmsAdapter,
    ...(config.kmsSeed === undefined ? {} : { seed: config.kmsSeed }),
  });
  const runtime = attachOnboardingWorkerRuntime({
    pool,
    keys,
    gateways: selectPaymentGateways(config.appEnv),
    ebarimt: selectEBarimt(config.appEnv),
    phone: selectPhoneVerification(config.appEnv),
    notifications: selectStaffNotification(config.appEnv),
    // The worker is the consumer of signals, never a producer.
    signals: new NoProvisioningSignal(),
    ...(config.parameters === undefined ? {} : { parameters: config.parameters }),
  });
  return {
    ...runtime,
    async close(): Promise<void> {
      await runtime.close();
      await pool.end().catch(() => undefined);
    },
  };
}

/** Builds the runtime over dependencies the caller owns — the test harness does. */
export function attachOnboardingWorkerRuntime(
  deps: OnboardingDependencies,
): OnboardingWorkerRuntime {
  const provisioning = new ProvisioningService(deps);
  const ebarimt = new EBarimtService(deps);
  const subscriptions = new SubscriptionService(deps);
  return {
    provisionDue: (limit) => provisioning.provisionDue(limit),
    provisionOne: (applicationId) => provisioning.provisionOne(applicationId),
    deliverActivations: (limit) => provisioning.drainActivationDeliveries(limit),
    issueReceipts: (limit) => ebarimt.drain(limit),
    applyUpgradeBoundaries: (limit) => subscriptions.applyDueUpgrades(limit),
    close: () => Promise.resolve(),
  };
}

export type { KeyManagementPort };
