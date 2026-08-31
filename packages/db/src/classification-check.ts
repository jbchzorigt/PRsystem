import type { Pool } from 'pg';
import type { ClassificationViolation } from './classification';
import { AUDIT_GRANT_POLICY, RUNTIME_ROLES, TABLE_CLASSIFICATION } from './classification';

/**
 * Compares the declared classification against what the live database enforces.
 *
 * Returns every violation rather than the first, so one run tells the whole
 * story instead of revealing problems one gate failure at a time.
 */
export async function validateClassification(pool: Pool): Promise<ClassificationViolation[]> {
  const violations: ClassificationViolation[] = [];

  const declared = new Map(
    TABLE_CLASSIFICATION.map((entry) => [`${entry.schema}.${entry.table}`, entry]),
  );

  // Every base table in a kernel schema, whether it carries a tenant column, and
  // its RLS flags. Partitions are excluded: they inherit their parent's policy.
  const tables = await pool.query<{
    qualified: string;
    has_tenant_column: boolean;
    has_restaurant_column: boolean;
    rls_enabled: boolean;
    rls_forced: boolean;
    owner: string;
  }>(
    `SELECT n.nspname || '.' || c.relname AS qualified,
            EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'hotel_id' AND a.attnum > 0
                       AND NOT a.attisdropped) AS has_tenant_column,
            EXISTS (SELECT 1 FROM pg_attribute a
                     WHERE a.attrelid = c.oid AND a.attname = 'restaurant_id' AND a.attnum > 0
                       AND NOT a.attisdropped) AS has_restaurant_column,
            c.relrowsecurity  AS rls_enabled,
            c.relforcerowsecurity AS rls_forced,
            pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname IN ('platform', 'audit', 'police_audit', 'police')
        AND c.relkind IN ('r', 'p')
        AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
      ORDER BY 1`,
  );

  for (const row of tables.rows) {
    const entry = declared.get(row.qualified);
    if (entry === undefined) {
      violations.push({
        kind: 'unclassified_table',
        detail: `${row.qualified} exists but is not in the classification manifest`,
      });
      continue;
    }

    if (row.has_tenant_column && entry.classification !== 'TENANT_RLS') {
      // An audit stream legitimately carries hotel_id so an investigation can be
      // scoped, and it is protected by something stronger than RLS: no runtime
      // role holds any privilege on it at all. That is not assumed here — it is
      // verified, so the exemption cannot become a hiding place.
      const isAuditClass =
        entry.classification === 'PLATFORM_AUDIT' || entry.classification === 'POLICE_ISOLATED';
      const runtimeGrants = isAuditClass
        ? await pool.query<{ grantee: string; privilege_type: string }>(
            `SELECT pg_get_userbyid(a.grantee) AS grantee, a.privilege_type
               FROM pg_class c
               JOIN pg_namespace n ON n.oid = c.relnamespace
          CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS a
              WHERE n.nspname = $1 AND c.relname = $2
                AND pg_get_userbyid(a.grantee) = ANY($3)`,
            [entry.schema, entry.table, RUNTIME_ROLES],
          )
        : { rows: [] };

      if (!isAuditClass) {
        violations.push({
          kind: 'tenant_column_not_tenant_rls',
          detail: `${row.qualified} carries hotel_id but is classified ${entry.classification}`,
        });
      } else {
        for (const grant of runtimeGrants.rows) {
          if (
            !(
              entry.classification === 'PLATFORM_AUDIT' && grant.grantee === 'prsystem_audit_reader'
            ) &&
            !(
              entry.classification === 'POLICE_ISOLATED' &&
              grant.grantee === 'prsystem_police_audit_reader'
            )
          ) {
            violations.push({
              kind: 'tenant_column_not_tenant_rls',
              detail: `${row.qualified} is exempt from RLS as an audit stream, but ${grant.grantee} holds ${grant.privilege_type} on it`,
            });
          }
        }
      }
    }

    // An account-scoped table is exempt from tenant RLS because it belongs to
    // no hotel — and that exemption holds only while it genuinely carries no
    // tenant column. A `hotel_id` or a `restaurant_id` appearing on one is the
    // exemption turning into a hiding place, so both are refused by name.
    if (entry.classification === 'ACCOUNT_GLOBAL' && row.has_restaurant_column) {
      violations.push({
        kind: 'account_global_carries_tenant_column',
        detail: `${row.qualified} is ACCOUNT_GLOBAL but carries restaurant_id`,
      });
    }

    if (entry.classification === 'TENANT_RLS' && !(row.rls_enabled && row.rls_forced)) {
      violations.push({
        kind: 'tenant_rls_not_forced',
        detail: `${row.qualified} is TENANT_RLS but RLS is enabled=${String(row.rls_enabled)} forced=${String(row.rls_forced)}`,
      });
    }

    if ((RUNTIME_ROLES as readonly string[]).includes(row.owner)) {
      violations.push({
        kind: 'runtime_role_owns_object',
        detail: `${row.qualified} is owned by the runtime role ${row.owner}`,
      });
    }
  }

  for (const entry of TABLE_CLASSIFICATION) {
    const qualified = `${entry.schema}.${entry.table}`;
    if (!tables.rows.some((row) => row.qualified === qualified)) {
      violations.push({
        kind: 'unclassified_table',
        detail: `${qualified} is in the manifest but does not exist in the database`,
      });
    }
  }

  // Audit grants: an exact allow-list, per stream, including partitions. A
  // partition created next month must be no more permissive than its parent.
  for (const [qualified, policy] of Object.entries(AUDIT_GRANT_POLICY)) {
    const [schema, table] = qualified.split('.') as [string, string];
    const grants = await pool.query<{ relname: string; grantee: string; privilege_type: string }>(
      `SELECT c.relname, g.grantee, g.privilege_type
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) AS a
         JOIN LATERAL (SELECT pg_get_userbyid(a.grantee) AS grantee,
                              a.privilege_type AS privilege_type) g ON true
        WHERE n.nspname = $1
          AND (c.relname = $2 OR c.relname LIKE $2 || '\\_%')
          AND g.grantee <> pg_get_userbyid(c.relowner)
        ORDER BY 1, 2, 3`,
      [schema, table],
    );

    const allowed = policy as Record<string, readonly string[]>;
    for (const grant of grants.rows) {
      const permitted = allowed[grant.grantee];
      if (permitted === undefined || !permitted.includes(grant.privilege_type)) {
        violations.push({
          kind: 'unauthorised_audit_grant',
          detail: `${schema}.${grant.relname}: ${grant.grantee} holds ${grant.privilege_type}`,
        });
      }
    }
  }

  return violations;
}
