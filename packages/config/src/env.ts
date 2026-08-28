import { z } from 'zod';

/**
 * Environment contract for the API and worker runtimes.
 *
 * Rules (CLAUDE.md §4, §9):
 *  - configuration is validated at startup and fails closed;
 *  - no default is supplied for a value that carries a secret;
 *  - a missing or malformed value stops the process rather than degrading behaviour.
 */

const nonEmpty = z.string().min(1);

/** Shared with the service-specific schemas that extend this one. */
export const postgresUrl = nonEmpty.refine((v) => /^postgres(ql)?:\/\//.test(v), {
  message: 'must be a postgres:// or postgresql:// URL',
});

const redisUrl = nonEmpty.refine((v) => /^rediss?:\/\//.test(v), {
  message: 'must be a redis:// or rediss:// URL',
});

const port = z.coerce.number().int().min(1).max(65535);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'ci', 'staging', 'production']).default('local'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_HOST: nonEmpty.default('0.0.0.0'),
  API_PORT: port.default(3000),

  DATABASE_URL: postgresUrl,
  /**
   * The migration principal's connection string — a restricted, non-superuser
   * login that is a member of prsystem_migrate and nothing else. Separate from
   * DATABASE_URL on purpose: the API and worker must never hold it, and the
   * runner verifies the principal before applying anything.
   */
  MIGRATION_DATABASE_URL: postgresUrl.optional(),
  REDIS_URL: redisUrl,

  /** Key management adapter. `none` fails closed; `local` is refused outside local/ci/test. */
  KMS_ADAPTER: z.string().default('none'),
  KMS_SEED: z.string().optional(),

  OBJECT_STORAGE_ENDPOINT: nonEmpty,
  OBJECT_STORAGE_REGION: nonEmpty.default('us-east-1'),
  OBJECT_STORAGE_BUCKET: nonEmpty,
  OBJECT_STORAGE_ACCESS_KEY_ID: nonEmpty,
  OBJECT_STORAGE_SECRET_ACCESS_KEY: nonEmpty,

  SMTP_HOST: nonEmpty,
  SMTP_PORT: port,

  OTEL_SERVICE_NAME: nonEmpty.default('prsystem'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Field names whose values must never be echoed in an error message.
 *
 * Service-specific schemas add their own; the redaction itself is shared, so a
 * new secret field is protected by naming it here or in `extraSecretKeys`.
 */
const SECRET_KEYS: readonly string[] = [
  'OBJECT_STORAGE_SECRET_ACCESS_KEY',
  'DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'REDIS_URL',
  'KMS_SEED',
];

export class EnvValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Parse and validate an environment source. Pure: takes the source explicitly so it
 * can be tested without mutating `process.env`.
 *
 * @throws EnvValidationError when any value is missing or malformed. Never returns
 *         a partially valid object, and never includes a secret value in the message.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (parsed.success) {
    return parsed.data;
  }
  throw new EnvValidationError(formatIssues(source, parsed.error.issues));
}

/**
 * Turns zod issues into `KEY: message` lines with secret values removed.
 *
 * Redaction is applied rather than merely intended: some zod messages quote the
 * value they rejected, and a rejected connection string still contains a live
 * password.
 */
export function formatIssues(
  source: NodeJS.ProcessEnv,
  issues: readonly z.ZodIssue[],
  extraSecretKeys: readonly string[] = [],
): string[] {
  const secrets = [...SECRET_KEYS, ...extraSecretKeys];
  return issues.map((issue) => {
    const key = issue.path.join('.') || '(root)';
    let message = issue.message;
    for (const secretKey of secrets) {
      const value = source[secretKey];
      if (typeof value === 'string' && value.length > 0 && message.includes(value)) {
        message = message.split(value).join('[redacted]');
      }
    }
    return `${key}: ${message}`;
  });
}

let cached: Env | undefined;

/** Lazily validated process environment. Throws on first access if invalid. */
export function env(): Env {
  cached ??= loadEnv(process.env);
  return cached;
}

/**
 * Reset hooks contributed by the service-specific schemas.
 *
 * Those modules import this one, so the dependency cannot run the other way.
 * Registering keeps `resetEnvCache()` a single seam: a test that changes the
 * environment does not have to know which service caches exist, which is what
 * would leave a stale API or worker configuration behind after a reset.
 */
const resetHooks = new Set<() => void>();

export function registerEnvCacheReset(reset: () => void): void {
  resetHooks.add(reset);
}

/** Test seam: clears every cached environment. */
export function resetEnvCache(): void {
  cached = undefined;
  for (const reset of resetHooks) reset();
}
