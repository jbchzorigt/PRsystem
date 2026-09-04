import type { PaymentProvider } from '@prsystem/ports';
import {
  PaymentGatewayRegistry,
  SimulatedPaymentGateway,
  PAYMENT_PROVIDERS,
} from '@prsystem/ports';
import { createHash, randomUUID } from 'node:crypto';
import type { CommandActor } from '../../iam/services/iam-context';
import type { StayHarness, StayHotel } from '../../stay/test-support/stay-harness';
import { createStayHarness, key, request } from '../../stay/test-support/stay-harness';
import { BillingDeposits } from '../contracts/stay-deposits';
import type { BillingDependencies } from '../services/billing-context';
import { DepositService } from '../services/deposit.service';
import { FinancialCorrectionService } from '../services/correction.service';
import { FolioService } from '../services/folio.service';
import { RefundService } from '../services/refund.service';
import { ReconciliationService } from '../services/reconciliation.service';

/**
 * The Phase 10 harness: the Phase 08/09 stay harness with a real deposit
 * implementation behind the check-in, and the billing services over the same
 * pool and clock. The payment providers are the deterministic simulators, so a
 * test can decide exactly what QPay says and when.
 */

export interface BillingHarness extends StayHarness {
  readonly gateways: PaymentGatewayRegistry;
  readonly simulators: ReadonlyMap<PaymentProvider, SimulatedPaymentGateway>;
  readonly folios: FolioService;
  readonly deposits2: DepositService;
  readonly refunds2: RefundService;
  readonly corrections2: FinancialCorrectionService;
  readonly cases: ReconciliationService;
  configureDeposit(hotel: StayHotel, amountMnt: bigint, categoryId?: string): Promise<void>;
  /**
   * A Platform Operation account with the named permissions and a recent
   * step-up, written the way the Phase 05 harness writes one: the session row
   * is real, so the pipeline reads the same epoch, grants and step-up instant
   * it would read in production (Operation sign-in itself is Phase 19's).
   */
  operationActor(permissions: readonly string[], stepUpAgeSeconds?: number): Promise<CommandActor>;
}

export async function createBillingHarness(suite: string): Promise<BillingHarness> {
  const simulators = new Map<PaymentProvider, SimulatedPaymentGateway>(
    PAYMENT_PROVIDERS.map((provider) => [provider, new SimulatedPaymentGateway(provider)]),
  );
  const gateways = new PaymentGatewayRegistry(new Map(simulators));
  const stay = await createStayHarness(suite, { deposits: new BillingDeposits() });
  const deps: BillingDependencies = {
    pool: stay.api,
    subscription: stay.deps.subscription,
    stays: stay.stays,
    reports: stay.reports,
    gateways,
    clock: stay.now,
  };
  const deposits2 = new DepositService(deps);
  return {
    ...stay,
    gateways,
    simulators,
    folios: new FolioService(deps),
    deposits2,
    refunds2: new RefundService(deps),
    corrections2: new FinancialCorrectionService(deps),
    cases: new ReconciliationService(deps),
    async operationActor(permissions, stepUpAgeSeconds = 0) {
      const created = await stay.admin.query<{ account_id: string }>(
        `INSERT INTO platform.user_account (realm, realm_role, email_normalized, email_verified_at)
         VALUES ('operation', 'OPERATION_ADMIN', $1, now()) RETURNING account_id`,
        [`operator-${randomUUID()}@operation.test`],
      );
      const accountId = created.rows[0]?.account_id as string;
      for (const permission of permissions) {
        await stay.admin.query(
          `INSERT INTO platform.account_permission_grant
             (account_id, realm, realm_role, permission, granted_by_account_id)
           VALUES ($1, 'operation', 'OPERATION_ADMIN', $2, $1)`,
          [accountId, permission],
        );
      }
      const session = await stay.admin.query<{ session_id: string; step_up_at: Date }>(
        `INSERT INTO platform.server_session
           (account_id, realm, token_hash, token_key_version, account_epoch,
            idle_expires_at, absolute_expires_at, step_up_at)
         VALUES ($1, 'operation', $2, 1, 0, now() + interval '1 hour',
                 now() + interval '8 hours', now() - make_interval(secs => $3))
         RETURNING session_id, step_up_at`,
        [accountId, createHash('sha256').update(randomUUID()).digest('hex'), stepUpAgeSeconds],
      );
      return {
        principal: {
          accountId,
          realm: 'operation',
          accountState: 'ACTIVE',
          memberships: [],
          directPermissions: [...permissions],
          realmRole: 'OPERATION_ADMIN',
          stepUpAt: session.rows[0]?.step_up_at as Date,
        },
        sessionId: session.rows[0]?.session_id as string,
      };
    },

    async configureDeposit(hotel, amountMnt, categoryId) {
      await deposits2.configure(
        {
          hotelId: hotel.hotelId,
          idempotencyKey: key('dc'),
          amountMnt,
          ...(categoryId === undefined ? {} : { categoryId }),
        },
        hotel.manager,
        request(hotel.manager),
      );
    },
  };
}

export { key, request };
