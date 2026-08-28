import { z } from 'zod';
import { EnvValidationError, formatIssues, postgresUrl } from './env';

/**
 * The migration-only configuration contract.
 *
 * Deliberately separate from the runtime contract rather than a superset of it.
 * The migration principal can apply DDL, so the variable naming it must not be
 * reachable from a module the API or worker imports: keeping it in the shared
 * schema meant both runtimes declared it, parsed it and returned it, whatever
 * they then did with the value.
 *
 * There is no fallback to `DATABASE_URL`. That variable holds a runtime
 * principal, and a migration applied as one would create objects owned by the
 * wrong role.
 */

export const migrationEnvSchema = z.object({
  /**
   * The restricted migration login: a member of `prsystem_migrate` and nothing
   * else, never a superuser. The runner verifies the principal before applying
   * anything.
   */
  MIGRATION_DATABASE_URL: postgresUrl,
  /**
   * Operator identities allowed to own the database and schema `public`.
   *
   * Mandatory, with no default: the migration principal never owns the
   * database, so any inferred value would either refuse every real deployment
   * or approve every owner.
   */
  PRSYSTEM_APPROVED_OPERATOR_OWNERS: z.string().min(1),
});

export interface MigrationEnv {
  readonly migrationDatabaseUrl: string;
  readonly approvedOperatorOwners: readonly string[];
}

/** Fields whose values must never appear in an error message. */
const MIGRATION_SECRET_KEYS = ['MIGRATION_DATABASE_URL'] as const;

/**
 * Parse and validate the migration environment.
 *
 * @throws EnvValidationError when the credential or the ownership contract is
 *         missing or malformed. The credential value is never echoed.
 */
export function loadMigrationEnv(source: NodeJS.ProcessEnv = process.env): MigrationEnv {
  const parsed = migrationEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new EnvValidationError(formatIssues(source, parsed.error.issues, MIGRATION_SECRET_KEYS));
  }

  const owners = parsed.data.PRSYSTEM_APPROVED_OPERATOR_OWNERS.split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  if (owners.length === 0) {
    throw new EnvValidationError([
      'PRSYSTEM_APPROVED_OPERATOR_OWNERS: must name at least one operator identity allowed to ' +
        'own the database. There is no default: the migration principal never owns the database, ' +
        'so any inferred value would either refuse every real deployment or approve every owner',
    ]);
  }

  return {
    migrationDatabaseUrl: parsed.data.MIGRATION_DATABASE_URL,
    approvedOperatorOwners: owners,
  };
}
