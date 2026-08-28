export { isSyntheticRegistrationNumber, syntheticIdentities, syntheticIdentity } from './synthetic';
export type { SyntheticIdentity } from './synthetic';
export {
  DEFAULT_ADMIN_URL,
  TEST_ADMIN_APPLICATION_NAME,
  TEST_DATABASE_PREFIX,
  TEST_LOGIN_PASSWORD,
  TEST_LOGIN_PRINCIPALS,
  adminUrl,
  createRolePool,
  UNATTRIBUTED_SCOPE,
  assertNoUnexpectedPoolErrors,
  assertScopeClean,
  closeTrackedPools,
  createTestDatabase,
  expectPoolTeardown,
  quietPool,
  resetPoolErrorReport,
  testDatabaseName,
  unexpectedPoolErrorReport,
} from './pg-harness';
export type { PoolErrorEntry, TestDatabase } from './pg-harness';
