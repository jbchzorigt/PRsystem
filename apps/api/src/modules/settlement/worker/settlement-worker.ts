import { Pool } from 'pg';
import { selectAdapters } from '@prsystem/ports';
import type { AdapterSelection } from '@prsystem/ports';
import { RepositoryBookingRefundAxis } from '../../booking/contracts/refund-axis';
import type { SettlementDependencies } from '../services/settlement-context';
import { BookingRefundService } from '../services/refund.service';
import { PayoutService } from '../services/payout.service';

/**
 * The Phase 14 provider jobs, as the worker deployment runs them (Phase 20;
 * doc 11 §7–§8, `PAY-DEC-006`, `PAY-DEC-009`).
 *
 * Two operations, one runtime, and each is the very method the API-side
 * service exposes: the refund executor asks the gateway to refund every open
 * obligation, and the payout runner assembles and submits every batch that has
 * fallen due. Both find their work through a `SECURITY DEFINER` resolver,
 * claim one row at a time under its own lock, and make the provider call
 * between two transactions — so a duplicated, delayed or lost message changes
 * nothing, and a provider that could not be reached decides nothing.
 *
 * Both reach a provider, and both are governed by a gate. `enabled` says which
 * of them the deployment's adapters can actually run: the consumer schedules
 * only those, because a sweep against a `DISABLED` adapter every minute would
 * be a job that exists to be refused. What the services do with `DISABLED` if
 * one is called anyway is treat it as no decision.
 */
export interface SettlementWorkerRuntime {
  /** Executes every open refund obligation. Answers how many reached the provider. */
  executeOpenRefunds(limit?: number): Promise<number>;
  /** Runs every due payout batch. Answers how many were settled either way. */
  runDuePayouts(limit?: number): Promise<number>;
  /** Which operations this deployment's adapters permit. */
  readonly enabled: { readonly refunds: boolean; readonly payouts: boolean };
  close(): Promise<void>;
}

export interface SettlementWorkerConfig {
  readonly databaseUrl: string;
  readonly adapters: AdapterSelection;
}

/** Builds the runtime from configuration, selecting the environment's adapters. */
export function createSettlementWorkerRuntime(
  config: SettlementWorkerConfig,
): SettlementWorkerRuntime {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const selected = selectAdapters(config.adapters);
  const described = selected.describe();
  const runs = (slot: string): boolean =>
    described.find((one) => one.slot === slot)?.mode !== 'disabled';
  const runtime = attachSettlementWorkerRuntime(
    {
      pool,
      payments: selected.payments,
      payouts: selected.payouts,
      bookings: new RepositoryBookingRefundAxis(),
    },
    // A refund goes to whichever provider took the payment, so refunds run
    // only when both gateways can be called.
    { refunds: runs('payment.qpay') && runs('payment.khaan'), payouts: runs('payout') },
  );
  return {
    ...runtime,
    async close(): Promise<void> {
      await runtime.close();
      await pool.end().catch(() => undefined);
    },
  };
}

/** Builds the runtime over dependencies the caller owns — the test harness does. */
export function attachSettlementWorkerRuntime(
  deps: SettlementDependencies,
  enabled: { readonly refunds: boolean; readonly payouts: boolean } = {
    refunds: true,
    payouts: true,
  },
): SettlementWorkerRuntime {
  const refunds = new BookingRefundService(deps);
  const payouts = new PayoutService(deps);
  return {
    executeOpenRefunds: (limit) => refunds.sweep(limit),
    runDuePayouts: async (limit) => (await payouts.runDue(limit)).length,
    enabled,
    close: () => Promise.resolve(),
  };
}
