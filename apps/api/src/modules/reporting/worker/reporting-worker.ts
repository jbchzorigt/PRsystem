import { Pool } from 'pg';
import { selectObjectStorage } from '@prsystem/ports';
import type { SubscriptionStatePort } from '@prsystem/authz';
import { DatabaseSubscriptionState } from '../../onboarding/contracts/subscription-state.adapter';
import { RepositoryFinancialReads } from '../../billing/contracts/financial-reads';
import { RepositoryExpenseReads } from '../../finance/contracts/expense-reads';
import { RepositoryMinibarReads } from '../../minibar/contracts/minibar-reads';
import { RepositoryRegistryFacts } from '../../stay/contracts/registry-reads';
import type { ReportingDependencies } from '../services/reporting-context';
import { ReportExportService } from '../services/export.service';
import { RetentionService } from '../services/retention.service';

/**
 * The Phase 17 background operations, as the worker deployment runs them
 * (doc 12 §7–§8, doc 23 §6).
 *
 * Three operations, one runtime, and each is the very method the API-side
 * service exposes — the worker does not re-implement an export, it runs the
 * one the API queued. All three are sweep-shaped: they find what is due in
 * PostgreSQL through a `SECURITY DEFINER` resolver, claim each row by
 * compare-and-set inside its own hotel's scope, and settle it there. A Redis
 * message only says "look now", so a duplicated, delayed or lost one changes
 * nothing.
 *
 * The database login is the worker's own restricted one, which holds `SELECT`
 * and `UPDATE` on the three tables these touch and nothing else — it cannot
 * create an export job, only run one.
 */
export interface ReportingWorkerRuntime {
  /** Builds and stores every queued export (`GUEST-DEC-006`). */
  runQueuedExports(limit?: number): Promise<number>;
  /** Deletes the files whose hour has passed and marks them EXPIRED (`GUEST-DEC-007`). */
  expireLapsedFiles(limit?: number): Promise<number>;
  /** Anonymises the stays past their retention deadline (`GUEST-DEC-008`). */
  purgeDueRetention(limit?: number): Promise<number>;
  close(): Promise<void>;
}

export interface ReportingWorkerConfig {
  readonly databaseUrl: string;
  readonly appEnv: string;
}

/** Builds the runtime from configuration, selecting the environment's storage. */
export function createReportingWorkerRuntime(
  config: ReportingWorkerConfig,
): ReportingWorkerRuntime {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 4 });
  const runtime = attachReportingWorkerRuntime({
    pool,
    subscription: new DatabaseSubscriptionState(pool),
    registry: new RepositoryRegistryFacts(),
    sales: new RepositoryFinancialReads(),
    minibar: new RepositoryMinibarReads(),
    expenses: new RepositoryExpenseReads(),
    // In production this is the disabled adapter behind `INT-STORAGE-01`: an
    // export then fails closed with a recorded reason rather than writing a
    // file nowhere (CLAUDE.md §9).
    storage: selectObjectStorage(config.appEnv),
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
export function attachReportingWorkerRuntime(deps: ReportingDependencies): ReportingWorkerRuntime {
  const exports = new ReportExportService(deps);
  const retention = new RetentionService(deps);
  return {
    runQueuedExports: (limit) => exports.runQueued(limit),
    expireLapsedFiles: (limit) => exports.sweepExpired(limit),
    purgeDueRetention: (limit) => retention.sweepRetention(limit),
    close: () => Promise.resolve(),
  };
}

export type { SubscriptionStatePort };
