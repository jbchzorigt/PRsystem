/**
 * The Phase 18 worker surface of the API package, consumed by the worker
 * deployment through `@prsystem/api/police-worker`.
 *
 * One runtime and one operation: consume the check-in events the Police matcher
 * has not seen. It holds no privilege on any Police table — what it may do is
 * call one `SECURITY DEFINER` function, which answers a match id or nothing.
 */
export {
  attachPoliceMatcherRuntime,
  createPoliceMatcherRuntime,
} from './modules/police/worker/police-worker';
export type {
  PoliceMatcherConfig,
  PoliceMatcherRuntime,
} from './modules/police/worker/police-worker';
