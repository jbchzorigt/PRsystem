import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';

/** The repository root, where docker-compose.yml lives. */
const COMPOSE_ROOT = resolve(dirname(__filename), '..', '..', '..', '..');

/**
 * A deterministic, normalized `pg_dump --schema-only` of one database.
 *
 * The migration contract is a byte-identical normalized schema dump after the
 * fresh and the upgrade paths. A hand-rolled catalogue fingerprint can only
 * compare the properties somebody thought to project; `pg_dump` emits the DDL
 * PostgreSQL itself would need to recreate the database, so anything it prints
 * and the fingerprint forgot is still compared here.
 *
 * The dump runs inside the pinned PostgreSQL 17 container, so the client version
 * always matches the server and the output cannot drift with whatever `pg_dump`
 * happens to be on a developer's PATH.
 */
export interface DumpOptions {
  /** Container name running the pinned PostgreSQL. */
  readonly container: string;
  readonly user: string;
  readonly database: string;
}

/**
 * Removes the parts of a dump that vary between two runs of the same schema and
 * nothing else.
 *
 * Only four things are normalized, each provably not schema:
 *
 *  - the header comments naming the dump and server versions;
 *  - the `\restrict` / `\unrestrict` psql guards, whose token is random per run;
 *  - the database name, since the two databases being compared necessarily have
 *    different names;
 *  - runs of blank lines.
 *
 * Owners, grants, policies, functions, triggers, comments, `reloptions` and
 * security properties are left exactly as emitted. Discarding any of them would
 * be discarding the security-relevant DDL this comparison exists to protect.
 */
export function normalizeDump(dump: string, database: string): string {
  return dump
    .split('\n')
    .filter((line) => !/^-- Dumped (from|by)/.test(line))
    .filter((line) => !/^\\(un)?restrict /.test(line))
    .map((line) => line.replaceAll(database, '<database>'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function schemaDump(options: DumpOptions): string {
  // No --no-owner and no --no-acl: ownership and grants are exactly what must
  // match between a fresh install and an upgraded one.
  const raw = execFileSync(
    'docker',
    [
      'exec',
      options.container,
      'pg_dump',
      '--schema-only',
      '-U',
      options.user,
      '-d',
      options.database,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return normalizeDump(raw, options.database);
}

/**
 * The container running this project's pinned PostgreSQL.
 *
 * Resolved through the Compose project's `postgres` service, never by scanning
 * for the first container whose *name* happens to contain "postgres". A
 * developer machine can easily be running an unrelated `hotel-platform-postgres`
 * or somebody else's database container, and dumping — or worse, executing
 * against — a stranger's container is not a mistake a test suite should be able
 * to make.
 *
 * `PRSYSTEM_POSTGRES_CONTAINER` overrides it with an explicit id, which is
 * verified to exist before it is used.
 */
export function pinnedContainer(): string {
  const explicit = process.env['PRSYSTEM_POSTGRES_CONTAINER'];
  if (explicit !== undefined && explicit.length > 0) {
    const found = execFileSync('docker', ['ps', '-q', '--no-trunc', '--filter', `id=${explicit}`], {
      encoding: 'utf8',
    }).trim();
    if (found.length === 0) {
      throw new Error(`PRSYSTEM_POSTGRES_CONTAINER=${explicit} is not a running container`);
    }
    return explicit;
  }

  const id = execFileSync('docker', ['compose', 'ps', '-q', 'postgres'], {
    encoding: 'utf8',
    cwd: COMPOSE_ROOT,
  })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)[0];

  if (id === undefined) {
    throw new Error(
      'the PRsystem compose `postgres` service is not running; start it with `pnpm run compose:up`',
    );
  }
  return id;
}
