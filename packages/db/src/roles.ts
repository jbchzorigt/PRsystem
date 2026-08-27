/**
 * The five database roles of ADR-0017 §5, plus the two audit reader roles.
 *
 * Runtime roles are NOLOGIN group roles: a deployment creates one login user per
 * runtime and grants it the role, so no credential is ever committed.
 */
export const DATABASE_ROLES = {
  /** DDL owner. Runs migrations only; never used at runtime. */
  migrate: 'prsystem_migrate',
  /** API runtime. Subject to RLS, no BYPASSRLS. */
  api: 'prsystem_api',
  /** Worker runtime. Subject to RLS, no BYPASSRLS. */
  worker: 'prsystem_worker',
  /** Police runtime. Reaches the police schemas and nothing else. */
  police: 'prsystem_police',
  /** Retention, rebuild and break-glass. The only BYPASSRLS role. */
  maintenance: 'prsystem_maintenance',
  /** Scoped SELECT on audit.platform_event. Cannot write. */
  auditReader: 'prsystem_audit_reader',
  /** Scoped SELECT on police_audit.security_event. Cannot write, and cannot read the platform stream. */
  policeAuditReader: 'prsystem_police_audit_reader',
} as const;

export type DatabaseRole = (typeof DATABASE_ROLES)[keyof typeof DATABASE_ROLES];

/** Roles that must never hold BYPASSRLS. Asserted by the RLS integration gate. */
export const ROLES_WITHOUT_BYPASSRLS: readonly DatabaseRole[] = [
  DATABASE_ROLES.migrate,
  DATABASE_ROLES.api,
  DATABASE_ROLES.worker,
  DATABASE_ROLES.police,
  DATABASE_ROLES.auditReader,
  DATABASE_ROLES.policeAuditReader,
];
