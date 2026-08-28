import { afterAll } from 'vitest';
// A relative import is safe because the harness anchors its bookkeeping to the
// process, not to the module instance: a test file resolves `@prsystem/testing`
// to the built package while this file is loaded by path, and without that
// anchor the two would keep separate, empty scope maps.
import { assertAllPoolScopesClean } from './pg-harness';

/**
 * Vitest setup: every test file ends by inspecting every pool-error scope.
 *
 * `createTestDatabase().drop()` asserts the lifecycle it owns, which leaves a
 * suite that manages its own `quietPool` recording errors into a scope no
 * assertion reads. Registering the check here makes it unconditional: a suite
 * cannot opt out by forgetting, and no bucket — default, coordination or
 * unattributed — ends a run uninspected.
 *
 * A suite that provokes an error deliberately still clears its own scope with
 * `resetPoolErrorReport(scope)`, which is per scope and cannot clear anybody
 * else's.
 */
afterAll(() => {
  assertAllPoolScopesClean();
});
