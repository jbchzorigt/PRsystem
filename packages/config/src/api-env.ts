import { z } from 'zod';
import {
  EnvValidationError,
  assertNoMigrationCredential,
  deriveEnv,
  envSchema,
  formatIssues,
  postgresUrl,
  registerEnvCacheReset,
  type Env,
} from './env';
import {
  callbackAllowlistSchema,
  refineAdapters,
  refineCallbackAllowlists,
  resolveCallbackAllowlists,
} from './adapters-env';
import type { CallbackAllowlists } from './adapters-env';

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

/**
 * Phase 18. The Police realm is a capability with its own restricted login, and
 * a deployment either holds it or does not: `prsystem_police` reaches no hotel
 * table, and the API's ordinary credential reaches no Police table, so there is
 * no way to serve the Police portal on the connection that serves the rest.
 */
export type PoliceConfig =
  { readonly enabled: false } | { readonly enabled: true; readonly databaseUrl: string };

export interface ApiEnv extends Env {
  readonly scheduler: SchedulerConfig;
  readonly police: PoliceConfig;
  /**
   * Phase 20. The source ranges a provider's callback may arrive from, per
   * provider. Absent means "not configured", which the guard treats as
   * "refuse every source" above test and "allow" below it.
   */
  readonly callbackAllowlists: CallbackAllowlists;
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

/**
 * Whether this API deployment serves the Police portal.
 *
 * Unlike the scheduler, this defaults **off everywhere including production**:
 * doc 13 §3 and ADR-0017 §6 treat the Police realm as a separate deployment
 * concern, and a production API that happens not to serve it is a normal
 * arrangement rather than a misconfiguration. Turning it on without the
 * credential is still refused.
 */
export function resolvePoliceEnabled(_appEnv: Env['APP_ENV'], raw: string | undefined): boolean {
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
    /** `true` / `false`. Absent means off, in every environment. */
    POLICE_ENABLED: z.enum(['true', 'false']).optional(),
    /**
     * The Police principal's connection string (doc 13 §3, ADR-0017 §6).
     *
     * A separate credential because it is a separate boundary: it holds the
     * `police` schema and the account tables the pipeline reads, and nothing of
     * a hotel's own data.
     */
    POLICE_DATABASE_URL: postgresUrl.optional(),
  })
  .extend(callbackAllowlistSchema.shape)
  .superRefine((value, ctx) => {
    // The shared adapter rules, attached here as well because this schema is
    // parsed on its own rather than through `loadEnv`.
    refineAdapters(value, value.APP_ENV, ctx);
    refineCallbackAllowlists(value, ctx);
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

    // The same two mistakes, for the Police credential. A capability advertised
    // with nothing behind it fails when the first officer signs in; a live
    // Police credential in a deployment that will never use it is privileged
    // configuration nobody is accounting for.
    const policeEnabled = resolvePoliceEnabled(value.APP_ENV, value.POLICE_ENABLED);
    const policeUrl = value.POLICE_DATABASE_URL;
    if (policeEnabled && (policeUrl === undefined || policeUrl.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['POLICE_DATABASE_URL'],
        message:
          'POLICE_DATABASE_URL is required when the Police realm is enabled; ' +
          'set POLICE_ENABLED=false for a deployment that does not serve the Police portal',
      });
    }
    if (!policeEnabled && policeUrl !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['POLICE_DATABASE_URL'],
        message:
          'POLICE_DATABASE_URL is set while the Police realm is disabled; ' +
          'remove the credential or set POLICE_ENABLED=true',
      });
    }
  });

/** Secret fields specific to the API contract. */
const API_SECRET_KEYS = ['SCHEDULER_DATABASE_URL', 'POLICE_DATABASE_URL'] as const;

/**
 * Parse and validate the API environment.
 *
 * @throws EnvValidationError when any value is missing, malformed, or forms an
 *         unusable capability/credential combination.
 */
export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  // Before anything is parsed: a runtime that has been handed the migration
  // credential is misconfigured whatever else is correct.
  assertNoMigrationCredential(source);

  const parsed = apiEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(formatIssues(source, parsed.error.issues, API_SECRET_KEYS));
  }

  const {
    SCHEDULER_ENABLED: _flag,
    SCHEDULER_DATABASE_URL: url,
    POLICE_ENABLED: _policeFlag,
    POLICE_DATABASE_URL: policeUrl,
    CALLBACK_ALLOWLIST_QPAY: _qpayList,
    CALLBACK_ALLOWLIST_KHAAN: _khaanList,
    ...raw
  } = parsed.data;
  const rest = deriveEnv(raw);
  const callbackAllowlists = resolveCallbackAllowlists(parsed.data);
  const enabled = resolveSchedulerEnabled(parsed.data.APP_ENV, parsed.data.SCHEDULER_ENABLED);

  // `enabled && url !== undefined` is guaranteed by the refinement above; the
  // check is here so the narrowing is the compiler's, not a comment's.
  const scheduler: SchedulerConfig =
    enabled && url !== undefined ? { enabled: true, databaseUrl: url } : { enabled: false };

  const policeEnabled = resolvePoliceEnabled(parsed.data.APP_ENV, parsed.data.POLICE_ENABLED);
  const police: PoliceConfig =
    policeEnabled && policeUrl !== undefined
      ? { enabled: true, databaseUrl: policeUrl }
      : { enabled: false };

  return { ...rest, scheduler, police, callbackAllowlists };
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
