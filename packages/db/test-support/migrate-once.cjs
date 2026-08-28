'use strict';
/**
 * One migration run, in its own OS process, with a parent-controlled start
 * barrier.
 *
 * `Promise.all([runMigrations(url), runMigrations(url)])` proves less than it
 * appears to: both calls resolve in the same event loop, so nothing shows that
 * the second runner ever waited on the advisory lock the first was holding. Two
 * real processes released together, each reporting the instants it entered and
 * left, make the contention observable — and make a sequential run fail the
 * overlap assertion instead of passing it silently.
 *
 * Plain CommonJS against the built `dist`, for the same reason as
 * `bootstrap-once.cjs`: a TypeScript loader inserts a wrapper process and the
 * READY handshake does not survive the extra hop.
 */
const { runMigrations } = require('../dist/migrate.js');

function waitForStart() {
  process.stdout.write('READY\n');
  return new Promise((resolve) => {
    const onData = () => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      // `resume()` refs the stream; without unref the child completes its work
      // and then never exits.
      process.stdin.unref();
      resolve();
    };
    process.stdin.on('data', onData);
    process.stdin.resume();
  });
}

async function main() {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) throw new Error('MIGRATE_DATABASE_URL is required');

  if (process.env.MIGRATE_WAIT_FOR_START === '1') await waitForStart();

  const enteredAt = Date.now();
  const outcome = await runMigrations(url);
  const leftAt = Date.now();

  process.stdout.write(
    `${JSON.stringify({
      pid: process.pid,
      enteredAt,
      leftAt,
      appliedBefore: outcome.appliedBefore,
      appliedAfter: outcome.appliedAfter,
    })}\n`,
    () => {
      process.exit(0);
    },
  );
}

main().catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : 'unknown error'}\n`);
  process.exit(1);
});
