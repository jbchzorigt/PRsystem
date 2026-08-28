import { z } from 'zod';
import {
  EnvValidationError,
  envSchema,
  formatIssues,
  postgresUrl,
  registerEnvCacheReset,
  type Env,
} from './env';

/**
 * API-specific configuration: the shared contract plus the D-09 scheduler
 * capability.
 *
 * This file is the *only* place the scheduler default lives. The shared schema
 * and the worker schema know nothing about the capability, so no other
 * deployment can inherit a default that quietly turns a privileged credential
 * on or accepts one it will never use.
 */

/**
 * The capability, resolved.
 *
 * A discriminated union rather than an enabled flag beside an optional URL:
 * when it is enabled the credential is present by construction, so nothing
 * downstream has to re-check a combination validation already settled.
 */
export type SchedulerConfig =
  { readonly enabled: false } | { readonly enabled: true; readonly databaseUrl: string };

export interface ApiEnv extends Env {
  readonly scheduler: SchedulerConfig;
}

/**
 * Whether this API deployment holds the scheduler capability.
 *
 * Production defaults on: issuing maintenance jobs is part of the intended
 * production API, so a missing credential there is a misconfiguration to be
 * reported at startup rather than a quiet opt-out. Everywhere else defaults
 * off, because a developer machine or a CI job that never sets the variable
 * should not be told it is missing a privileged credential it has no use for.
 */
export function resolveSchedulerEnabled(appEnv: Env['APP_ENV'], raw: string | undefined): boolean {
  if (raw === undefined) return appEnv === 'production';
  return raw === 'true';
}

export const apiEnvSchema = envSchema
  .extend({
    /** `true` / `false`. Absent means the environment-specific default above. */
    SCHEDULER_ENABLED: z.enum(['true', 'false']).optional(),
    /**
     * The job-scheduler principal's connection string (D-09).
     *
     * Only the API deployment is given this value. A worker that could issue
     * its own authorisation is exactly the arrangement D-09 exists to prevent.
     */
    SCHEDULER_DATABASE_URL: postgresUrl.optional(),
  })
  .superRefine((value, ctx) => {
    const enabled = resolveSchedulerEnabled(value.APP_ENV, value.SCHEDULER_ENABLED);
    const url = value.SCHEDULER_DATABASE_URL;

    // Enabled with no credential, in *every* environment. Restricting this to
    // production let a staging or CI API start with the capability advertised
    // and nothing behind it, failing only when somebody first issued a job.
    if (enabled && (url === undefined || url.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCHEDULER_DATABASE_URL'],
        message:
          'SCHEDULER_DATABASE_URL is required when the scheduler capability is enabled; ' +
          'set SCHEDULER_ENABLED=false for a deployment that genuinely has no scheduler',
      });
    }

    // Disabled with a credential. Stale privileged configuration: a live
    // scheduler credential in the environment of a deployment that will never
    // use it is one nobody is accounting for, not a harmless leftover.
    if (!enabled && url !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SCHEDULER_DATABASE_URL'],
        message:
          'SCHEDULER_DATABASE_URL is set while the scheduler capability is disabled; ' +
          'remove the credential or set SCHEDULER_ENABLED=true',
      });
    }
  });

/** Secret fields specific to the API contract. */
const API_SECRET_KEYS = ['SCHEDULER_DATABASE_URL'] as const;

/**
 * Parse and validate the API environment.
 *
 * @throws EnvValidationError when any value is missing, malformed, or forms an
 *         unusable capability/credential combination.
 */
export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  const parsed = apiEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(formatIssues(source, parsed.error.issues, API_SECRET_KEYS));
  }

  const { SCHEDULER_ENABLED: _flag, SCHEDULER_DATABASE_URL: url, ...rest } = parsed.data;
  const enabled = resolveSchedulerEnabled(parsed.data.APP_ENV, parsed.data.SCHEDULER_ENABLED);

  // `enabled && url !== undefined` is guaranteed by the refinement above; the
  // check is here so the narrowing is the compiler's, not a comment's.
  const scheduler: SchedulerConfig =
    enabled && url !== undefined ? { enabled: true, databaseUrl: url } : { enabled: false };

  return { ...rest, scheduler };
}

let cached: ApiEnv | undefined;

/** Lazily validated API environment. Throws on first access if invalid. */
export function apiEnv(): ApiEnv {
  cached ??= loadApiEnv(process.env);
  return cached;
}

/** Test seam: clears the cached API environment. */
export function resetApiEnvCache(): void {
  cached = undefined;
}

registerEnvCacheReset(resetApiEnvCache);
