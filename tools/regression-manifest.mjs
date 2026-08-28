// The exhaustive list of Phase 03 security regression suites.
//
// GATE-SEC runs the whole `src/regression` directory, so nothing can be skipped
// by omission. This manifest is the second half of that guarantee: adding a
// regression file without listing it here fails `validate:regression-coverage`,
// which makes "we forgot to wire the new suite in" a build failure rather than a
// silent gap. Both directions are checked — a listed file that no longer exists
// fails too.
export const REGRESSION_DIR = 'packages/db/src/regression';

export const REGRESSION_SUITES = [
  // First review: bootstrap separation, maintenance containment, audit writes.
  'phase03-repair.test.ts',
  // Third review: bootstrap target database, exact recursive principal closure.
  'phase03-repair2.test.ts',
  // Fourth review: PostgreSQL 17 membership options — MEMBER, USAGE, SET, ADMIN.
  'phase03-repair3.test.ts',
  // Fifth review: reader/scheduler containment, the SQL precondition, and the
  // zero/partial-login bootstrap.
  'phase03-repair4.test.ts',
];
