'use strict';
/**
 * One bootstrap run, in its own OS process, with a parent-controlled start
 * barrier.
 *
 * Plain CommonJS against the built `dist` on purpose: a TypeScript loader adds a
 * wrapper process, and the READY/start handshake this test depends on does not
 * survive that extra hop — the children run happily while the parent waits for a
 * line written to a pipe it does not hold.
 *
 * Prints `READY`, waits for the parent to release it, then reports its pid and
 * the instants it entered and left bootstrap so the parent can assert observable
 * overlap rather than asserting nothing.
 */
const { bootstrapCluster, LOGIN_PRINCIPALS } = require('../dist/bootstrap.js');

function waitForStart() {
  process.stdout.write('READY\n');
  return new Promise((resolve) => {
    const onData = () => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      // `resume()` refs the stream and keeps the event loop alive; without this
      // the child finishes its work and then simply never exits, which is
      // indistinguishable from a hung bootstrap.
      process.stdin.unref();
      resolve();
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function main() {
  const adminUrl = process.env.BOOTSTRAP_DATABASE_URL;
  const database = process.env.BOOTSTRAP_TARGET_DATABASE;
  const password = process.env.BOOTSTRAP_TEST_PASSWORD;

  if (!adminUrl || !database || !password) {
    throw new Error(
      'BOOTSTRAP_DATABASE_URL, BOOTSTRAP_TARGET_DATABASE and BOOTSTRAP_TEST_PASSWORD are required',
    );
  }

  if (process.env.BOOTSTRAP_WAIT_FOR_START === '1') await waitForStart();

  const enteredAt = Date.now();
  await bootstrapCluster({
    adminUrl,
    database,
    logins: Object.keys(LOGIN_PRINCIPALS).map((principal) => ({ principal, password })),
  });
  const leftAt = Date.now();

  process.stdout.write(`${JSON.stringify({ pid: process.pid, enteredAt, leftAt })}\n`, () => {
    // Exit only once the report has actually been flushed to the parent's pipe.
    process.exit(0);
  });
}

main().catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : 'unknown error'}\n`);
  process.exit(1);
});
