export { MIGRATIONS_FOLDER, runMigrations } from './migrate';
export type { MigrationOutcome, RunMigrationsOptions } from './migrate';
export {
  BOOTSTRAP_SQL,
  BootstrapError,
  GROUP_ROLES,
  LOGIN_PRINCIPALS,
  UNREACHABLE_ROLES,
  bootstrapCluster,
} from './bootstrap';
export type {
  BootstrapOptions,
  BootstrapResult,
  LoginCredential,
  LoginPrincipal,
} from './bootstrap';
export {
  FORBIDDEN_FOR_RUNTIME,
  PrincipalError,
  assertMigrationPrincipal,
  assertRuntimePrincipal,
  readPrincipalFacts,
} from './principal-guard';
export type { PrincipalFacts } from './principal-guard';
export { DATABASE_ROLES, ROLES_WITHOUT_BYPASSRLS } from './roles';
export type { DatabaseRole } from './roles';
export {
  PLATFORM_SCOPE,
  REALMS,
  TenantScopeError,
  assertTenantContext,
  isPlatformScope,
} from './tenant-context';
export type { Realm, TenantContext } from './tenant-context';
export { readSessionScope, withTenantTransaction } from './unit-of-work';
export type { UnitOfWork } from './unit-of-work';
export { ScopedRepository } from './scoped-repository';
export {
  canonicalJson,
  claimIdempotencyKey,
  completeIdempotencyKey,
  requestHash,
} from './kernel/idempotency';
export type { IdempotencyOutcome, IdempotencyRequest } from './kernel/idempotency';
export { recordPlatformAudit, recordPoliceAudit } from './kernel/audit';
export type { AuditOutcome, PlatformAuditEvent, PoliceAuditEvent } from './kernel/audit';
export {
  appendOutboxEvent,
  claimOutboxBatch,
  markOutboxFailed,
  markOutboxPublished,
} from './kernel/outbox';
export type { ClaimedOutboxEvent, OutboxEventInput } from './kernel/outbox';
export { claimConsumption, payloadHash, registerProviderEvent } from './kernel/inbox';
export type { ProviderEventInput, ProviderEventOutcome } from './kernel/inbox';
export {
  advanceCheckpoint,
  beginRebuild,
  readFreshness,
  registerProjection,
  setProjectionStatus,
} from './kernel/projections';
export type { ProjectionFreshness, ProjectionStatus } from './kernel/projections';
export {
  AUDIT_STREAMS,
  HORIZON_TARGET_MONTHS,
  HORIZON_THRESHOLD_MONTHS,
  checkPartitionHorizon,
  ensureAuditPartitions,
  readPartitionHorizons,
  runPartitionMaintenance,
} from './kernel/partitions';
export type { PartitionHorizon } from './kernel/partitions';
export { AUDIT_GRANT_POLICY, RUNTIME_ROLES, TABLE_CLASSIFICATION } from './classification';
export type { ClassificationViolation, ClassifiedTable, TableClass } from './classification';
export { validateClassification } from './classification-check';
