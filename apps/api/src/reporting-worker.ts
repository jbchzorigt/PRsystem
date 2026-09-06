/**
 * The Phase 17 worker surface of the API package, consumed by the worker
 * deployment through `@prsystem/api/reporting-worker`.
 *
 * One API deployment and one worker deployment share modules, not a network
 * (CLAUDE.md §1). What crosses here is the runtime the worker drives — three
 * sweeps over rows PostgreSQL owns — and nothing else.
 */
export {
  attachReportingWorkerRuntime,
  createReportingWorkerRuntime,
} from './modules/reporting/worker/reporting-worker';
export type {
  ReportingWorkerConfig,
  ReportingWorkerRuntime,
} from './modules/reporting/worker/reporting-worker';
