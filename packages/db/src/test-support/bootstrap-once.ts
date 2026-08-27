import { LOGIN_PRINCIPALS, bootstrapCluster } from '../bootstrap';
import type { LoginPrincipal } from '../bootstrap';

/**
 * A single bootstrap run in its own process.
 *
 * Used by the concurrency test: two of these start together against different
 * scratch databases in one cluster, which is the shape that races on the
 * cluster-wide role catalog unless the coordination lock actually covers the
 * whole operation.
 */
async function main(): Promise<void> {
  const adminUrl = process.env['BOOTSTRAP_DATABASE_URL'];
  const database = process.env['BOOTSTRAP_TARGET_DATABASE'];
  const password = process.env['BOOTSTRAP_TEST_PASSWORD'];

  if (adminUrl === undefined || database === undefined || password === undefined) {
    throw new Error(
      'BOOTSTRAP_DATABASE_URL, BOOTSTRAP_TARGET_DATABASE and BOOTSTRAP_TEST_PASSWORD are required',
    );
  }

  await bootstrapCluster({
    adminUrl,
    database,
    logins: (Object.keys(LOGIN_PRINCIPALS) as LoginPrincipal[]).map((principal) => ({
      principal,
      password,
    })),
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'unknown error'}\n`);
  process.exit(1);
});
