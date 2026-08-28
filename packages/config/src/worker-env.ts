import { EnvValidationError, loadEnv, registerEnvCacheReset, type Env } from './env';

/**
 * Worker-specific configuration: the shared contract and nothing else.
 *
 * The worker has no scheduler capability, so its configuration does not
 * declare, parse, return or expose the scheduler credential. What it does do is
 * refuse to start when one is present.
 *
 * Ignoring the variable would be worse than refusing it. An operator who copied
 * the API's environment into the worker has broken the D-09 separation, and a
 * worker that starts anyway leaves them believing the separation still holds.
 */
export type WorkerEnv = Env;

/**
 * Variables that belong to the API control plane alone.
 *
 * Presence is all that is inspected. The value is never read, parsed, logged or
 * returned — a credential this process must not hold is not one it should be
 * handling in order to reject it.
 */
const API_ONLY_KEYS = ['SCHEDULER_DATABASE_URL', 'SCHEDULER_ENABLED'] as const;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const present = API_ONLY_KEYS.filter((key) => source[key] !== undefined);
  if (present.length > 0) {
    throw new EnvValidationError(
      present.map(
        (key) =>
          `${key}: must not be set on the worker deployment; issuing maintenance jobs is an ` +
          'API control-plane capability (D-09) and the worker must never hold its credential',
      ),
    );
  }
  return loadEnv(source);
}

let cached: WorkerEnv | undefined;

/** Lazily validated worker environment. Throws on first access if invalid. */
export function workerEnv(): WorkerEnv {
  cached ??= loadWorkerEnv(process.env);
  return cached;
}

/** Test seam: clears the cached worker environment. */
export function resetWorkerEnvCache(): void {
  cached = undefined;
}

registerEnvCacheReset(resetWorkerEnvCache);
