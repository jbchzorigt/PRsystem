// The GATE-SEC sub-gate table.
//
// Extracted so it can be inspected rather than parsed. `validate:regression-coverage`
// imports these values directly; a validator that regexed the runner's source
// could be fooled by a comment, and would break the moment the list stopped
// being a literal.
import { REGRESSION_DIR, REGRESSION_SUITES } from './regression-manifest.mjs';

/** Each sub-gate names the package, the suite, and the artefacts it depends on. */
export const SUB_GATES = [
  {
    id: 'SEC-ROLE',
    what: 'cluster roles, login principals and startup credential guards',
    filter: '@prsystem/db',
    suite: 'src/security/sec-role.test.ts',
    needsDatabase: true,
    artefacts: ['packages/db/bootstrap/cluster-roles.sql', 'packages/db/src/principal-guard.ts'],
  },
  {
    id: 'SEC-RLS',
    what: 'tenant isolation and the database classification manifest',
    filter: '@prsystem/db',
    suite: 'src/security/sec-rls.test.ts',
    needsDatabase: true,
    artefacts: ['packages/db/src/classification.ts', 'packages/db/src/classification-check.ts'],
  },
  {
    id: 'SEC-ACL-MATRIX',
    what: 'every tenant table × runtime login × DML verb, with exact SQLSTATEs',
    filter: '@prsystem/db',
    suite: 'src/security/sec-acl-matrix.test.ts',
    needsDatabase: true,
    artefacts: ['packages/db/src/security/sec-acl-matrix.test.ts'],
  },
  {
    id: 'SEC-OWNERSHIP',
    what: 'object ownership and serialised cluster bootstrap',
    filter: '@prsystem/db',
    suite: 'src/security/sec-ownership.test.ts',
    needsDatabase: true,
    artefacts: [
      'packages/db/bootstrap/cluster-roles.sql',
      'packages/db/test-support/bootstrap-once.cjs',
    ],
  },
  {
    id: 'SEC-MAINTENANCE',
    what: 'maintenance is accountable: generated audit id, no invented reference',
    filter: '@prsystem/db',
    suite: 'src/security/sec-maintenance.test.ts',
    needsDatabase: true,
    artefacts: ['packages/db/migrations/0001_kernel.sql'],
  },
  {
    id: 'SEC-STARTUP',
    what: 'real API startup refuses before a port is bound',
    filter: '@prsystem/api',
    suite: 'src/security',
    needsDatabase: true,
    artefacts: [
      'apps/api/src/observability/connection-guard.ts',
      'apps/api/src/security/startup-order.test.ts',
    ],
  },
  {
    id: 'SEC-STARTUP-WORKER',
    what: 'worker startup never reaches Redis or BullMQ when a guard refuses',
    filter: '@prsystem/worker',
    suite: 'src/startup.test.ts',
    needsDatabase: true,
    artefacts: ['apps/worker/src/startup.ts', 'apps/worker/src/observability/connection-guard.ts'],
  },
  {
    id: 'SEC-REGRESSION',
    what: 'every reproduced Phase 03 review defect stays fixed',
    filter: '@prsystem/db',
    // The whole directory, not one file. Naming a single suite is how the
    // membership-option regressions were left out of this gate while it still
    // reported PASS.
    suite: 'src/regression',
    needsDatabase: true,
    artefacts: REGRESSION_SUITES.map((suite) => `${REGRESSION_DIR}/${suite}`),
  },
  {
    id: 'SEC-AUDIT',
    what: 'audit write security, append-only enforcement and nested sanitisation',
    filter: '@prsystem/db',
    suite: 'src/security/sec-audit.test.ts',
    needsDatabase: true,
    artefacts: ['packages/db/migrations/0001_kernel.sql'],
  },
  {
    id: 'SEC-PARTITION',
    what: 'audit partition renewal without DDL rights',
    filter: '@prsystem/db',
    suite: 'src/security/sec-partition.test.ts',
    needsDatabase: true,
    artefacts: ['packages/db/migrations/0001_kernel.sql'],
  },
  {
    id: 'SEC-POLICE-ISOLATION',
    what: 'no principal reaches both the Hotel and Police realms',
    filter: '@prsystem/db',
    suite: 'src/security/sec-police-isolation.test.ts',
    needsDatabase: true,
    artefacts: ['packages/db/migrations/0001_kernel.sql'],
  },
  {
    id: 'SEC-KMS',
    what: 'key management fails closed and realms never share key material',
    filter: '@prsystem/ports',
    suite: 'src/security/sec-kms.test.ts',
    needsDatabase: false,
    artefacts: ['packages/ports/src/select-key-management.ts'],
  },
  {
    id: 'SEC-PII-LEAK',
    what: 'planted canaries reach no durable record and no log',
    filter: '@prsystem/db',
    suite: 'src/integration/leakage.test.ts',
    needsDatabase: true,
    artefacts: ['packages/db/src/integration/leakage.test.ts'],
  },
  {
    id: 'SEC-SECRETS',
    what: 'no committed secret and no EXT register drift',
    filter: '@prsystem/db',
    suite: 'src/security/sec-ext-register.test.ts',
    needsDatabase: true,
    artefacts: ['tools/scan-secrets.mjs'],
    also: ['node', ['tools/scan-secrets.mjs']],
  },
];
