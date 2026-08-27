-- PRsystem cluster role bootstrap.
--
-- Runs ONCE PER PostgreSQL CLUSTER, not per database, and NOT as part of the
-- application migration journal. Roles and role attributes live in cluster-wide
-- catalogs (pg_authid, pg_auth_members); mutating them from a per-database
-- migration makes two concurrent migrations contend for the same catalog tuple
-- and gives the migration principal privileges it must never hold.
--
-- Contains NO credential. LOGIN principals are created separately, by the
-- bootstrap runner, from deployment-supplied configuration only.
--
-- Requires a privileged operator (a superuser, or a role with CREATEROLE plus
-- the ability to grant BYPASSRLS). That is a DBA/IaC step — see
-- docs/implementation/database-bootstrap-runbook.md.

-- Cluster-wide serialisation. The bootstrap connects to one designated database,
-- so a session-level advisory lock on a fixed key serialises every runner.
SELECT pg_advisory_xact_lock(hashtext('prsystem.cluster.bootstrap'));
--> statement-breakpoint

DO $bootstrap$
DECLARE
  r record;
  v_sql text;
BEGIN
  -- Every role is NOLOGIN. A login principal is a separate, deployment-created
  -- role that is granted one of these groups.
  --
  -- `bypassrls` is true for exactly one role: prsystem_maintenance, which owns
  -- the cross-tenant SECURITY DEFINER functions. Nothing is ever a member of it.
  FOR r IN
    SELECT * FROM (VALUES
      -- runtime groups
      ('prsystem_api',                 false),
      ('prsystem_worker',              false),
      ('prsystem_police',              false),
      ('prsystem_audit_reader',        false),
      ('prsystem_police_audit_reader', false),
      -- DDL owner group; the migration login is a member of this and nothing else
      ('prsystem_migrate',             false),
      -- narrow SECURITY DEFINER function owners. None holds BYPASSRLS: a
      -- cross-tenant job establishes scope per tenant (ADR-0017 §7) rather than
      -- bypassing the policy wholesale. prsystem_migrate is granted these so it
      -- can assign object ownership; no runtime role ever is.
      ('prsystem_audit_writer',        false),
      ('prsystem_partition_mgr',       false),
      ('prsystem_maintenance_fn',      false),
      -- Break-glass only. Holds BYPASSRLS, owns nothing, is reachable by nobody
      -- — not even the migration principal — and no application connects as it.
      ('prsystem_maintenance',         true)
    ) AS t(role_name, wants_bypassrls)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', r.role_name);
      EXCEPTION WHEN duplicate_object THEN
        NULL;  -- another runner won the race; the attribute pass below still applies
      END;
    END IF;

    -- Exact safe attributes, asserted rather than assumed. Written only when the
    -- current state differs, so re-running touches no catalog tuple.
    v_sql := format(
      'ALTER ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOLOGIN %s',
      r.role_name,
      CASE WHEN r.wants_bypassrls THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END
    );
    IF EXISTS (
      SELECT 1 FROM pg_roles
       WHERE rolname = r.role_name
         AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolcanlogin
              OR rolbypassrls IS DISTINCT FROM r.wants_bypassrls)
    ) THEN
      EXECUTE v_sql;
    END IF;
  END LOOP;
END
$bootstrap$;
--> statement-breakpoint

-- The privilege-escalation edges that must not exist.
--
-- A member of prsystem_maintenance would inherit BYPASSRLS; a member of
-- prsystem_migrate could issue DDL; a member of a function-owner role could
-- bypass the SECURITY DEFINER wrapper entirely. Revoking is idempotent and
-- costs nothing when the edge was never created.
DO $memberships$
DECLARE
  v_owner text;
  v_runtime text;
BEGIN
  FOREACH v_owner IN ARRAY ARRAY[
    'prsystem_maintenance', 'prsystem_maintenance_fn', 'prsystem_audit_writer',
    'prsystem_partition_mgr', 'prsystem_migrate'
  ] LOOP
    FOREACH v_runtime IN ARRAY ARRAY[
      'prsystem_api', 'prsystem_worker', 'prsystem_police',
      'prsystem_audit_reader', 'prsystem_police_audit_reader'
    ] LOOP
      EXECUTE format('REVOKE %I FROM %I', v_owner, v_runtime);
    END LOOP;
  END LOOP;

  -- The migration principal owns objects, so it must be able to assign them to
  -- their narrow owners. It is never given the BYPASSRLS break-glass role.
  FOREACH v_owner IN ARRAY ARRAY[
    'prsystem_audit_writer', 'prsystem_partition_mgr', 'prsystem_maintenance_fn'
  ] LOOP
    EXECUTE format('GRANT %I TO %I', v_owner, 'prsystem_migrate');
  END LOOP;
  REVOKE prsystem_maintenance FROM prsystem_migrate;
END
$memberships$;
--> statement-breakpoint

-- PUBLIC may not create objects in `public` anywhere in this cluster.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
