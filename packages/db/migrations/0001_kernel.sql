-- Platform transaction kernel.
--
-- Establishes tenancy, audit, idempotency, outbox, inbox and job/projection
-- metadata. It creates NO business-domain table: no hotel, guest, room, staff,
-- subscription, booking, restaurant or Police case row type exists yet.
--
-- ADR-0017 (RLS + roles), ADR-0018 (audit partitioning), ADR-0019 (projections),
-- ADR-0009 (append-only), ADR-0010 (outbox), ADR-0004 (versioned migrations).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- ------------------------------------------------- bootstrap precondition
-- Roles are NOT created here. They are cluster-global objects created once per
-- cluster by packages/db/bootstrap/cluster-roles.sql, run by a privileged
-- operator. A migration that mutated them would race across databases and would
-- need privileges the migration principal must never hold.
--
-- This migration therefore refuses to run against a cluster that has not been
-- bootstrapped, or whose roles have drifted into an unsafe shape. Failing here
-- is the whole point: the alternative is a schema whose grants reference roles
-- that do not exist, or that are more powerful than the design allows.
DO $precondition$
DECLARE
  r record;
  v_missing text[] := ARRAY[]::text[];
  v_unsafe  text[] := ARRAY[]::text[];
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('prsystem_api',                 false),
      ('prsystem_worker',              false),
      ('prsystem_police',              false),
      ('prsystem_audit_reader',        false),
      ('prsystem_police_audit_reader', false),
      ('prsystem_migrate',             false),
      ('prsystem_audit_writer',        false),
      ('prsystem_partition_mgr',       false),
      ('prsystem_maintenance_fn',      false),
      ('prsystem_maintenance',         true)
    ) AS t(role_name, expect_bypassrls)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role_name) THEN
      v_missing := v_missing || r.role_name;
    ELSIF EXISTS (
      SELECT 1 FROM pg_roles
       WHERE rolname = r.role_name
         AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolcanlogin
              OR rolbypassrls IS DISTINCT FROM r.expect_bypassrls)
    ) THEN
      v_unsafe := v_unsafe || r.role_name;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'cluster bootstrap has not run: missing role(s) %. Run packages/db/bootstrap/cluster-roles.sql first.',
      array_to_string(v_missing, ', ')
      USING ERRCODE = '42704';
  END IF;

  IF array_length(v_unsafe, 1) IS NOT NULL THEN
    RAISE EXCEPTION
      'cluster roles are unsafe: % carry a forbidden attribute (LOGIN, SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, or the wrong BYPASSRLS).',
      array_to_string(v_unsafe, ', ')
      USING ERRCODE = '42501';
  END IF;

  -- No runtime group may be able to reach a function-owner or the DDL owner.
  FOR r IN
    SELECT owner.rolname AS owner_name, runtime.rolname AS runtime_name
      FROM pg_roles owner, pg_roles runtime
     WHERE owner.rolname IN ('prsystem_maintenance', 'prsystem_maintenance_fn',
                             'prsystem_audit_writer', 'prsystem_partition_mgr',
                             'prsystem_migrate')
       AND runtime.rolname IN ('prsystem_api', 'prsystem_worker', 'prsystem_police',
                               'prsystem_audit_reader', 'prsystem_police_audit_reader')
       AND pg_has_role(runtime.rolname, owner.oid, 'USAGE')
  LOOP
    RAISE EXCEPTION 'role % can reach %, which breaks the privilege separation this schema depends on',
      r.runtime_name, r.owner_name USING ERRCODE = '42501';
  END LOOP;
END
$precondition$;
--> statement-breakpoint

-- ---------------------------------------------------------------- schemas
CREATE SCHEMA IF NOT EXISTS platform;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS audit;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS police_audit;
--> statement-breakpoint
-- Empty by design. Police case data arrives in Phase 18; the schema and its role
-- exist now so ADR-0017 §6 separation is a database guarantee from the kernel on.
CREATE SCHEMA IF NOT EXISTS police;
--> statement-breakpoint

-- ADR-0017 §5: `prsystem_maintenance` owns nothing and holds **no standing
-- grant**. It previously held USAGE on all four schemas, which contradicted the
-- ADR: a break-glass identity with permanent reach is not break-glass. A DBA
-- acting under an incident grants what that incident needs, at the time, under
-- its own audit trail — and revokes it afterwards.
GRANT USAGE ON SCHEMA platform TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT USAGE ON SCHEMA audit TO prsystem_api, prsystem_worker, prsystem_audit_reader;
--> statement-breakpoint
GRANT USAGE ON SCHEMA police_audit TO prsystem_police, prsystem_police_audit_reader;
--> statement-breakpoint
GRANT USAGE ON SCHEMA police TO prsystem_police;
--> statement-breakpoint
REVOKE ALL ON SCHEMA platform, audit, police_audit, police FROM prsystem_maintenance;
--> statement-breakpoint

-- SECURITY DEFINER owners resolve fully qualified objects in these schemas, so
-- each needs USAGE on exactly the schemas its function bodies touch and nothing
-- more. None of them can connect; none is reachable by a runtime role.
-- CREATE is required to *own* an object in a schema, and the partition manager
-- additionally needs it to attach a new monthly partition. It is granted to
-- these three unreachable owner roles and to no runtime role.
GRANT USAGE, CREATE ON SCHEMA platform
  TO prsystem_audit_writer, prsystem_partition_mgr, prsystem_maintenance_fn;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA audit TO prsystem_audit_writer, prsystem_partition_mgr;
--> statement-breakpoint
GRANT USAGE, CREATE ON SCHEMA police_audit TO prsystem_audit_writer, prsystem_partition_mgr;
--> statement-breakpoint

-- ------------------------------------------------- tenant context functions
-- ADR-0017 §2: the context is transaction-scoped (`SET LOCAL`) and derived on the
-- server. `current_setting(..., true)` returns NULL when unset, so an unscoped
-- query matches no row rather than every row.
CREATE OR REPLACE FUNCTION platform.current_hotel_id() RETURNS uuid
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.hotel_id', true), '')::uuid
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.current_realm() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.realm', true), '')
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.current_actor_ref() RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.actor_ref', true), '')
$$;
--> statement-breakpoint

-- Operations that belong to the platform rather than to a hotel carry this
-- sentinel instead of NULL, so every tenant-scoped column stays NOT NULL and the
-- RLS predicate never has to reason about NULL.
CREATE OR REPLACE FUNCTION platform.platform_scope() RETURNS uuid
  LANGUAGE sql IMMUTABLE AS $$
  SELECT '00000000-0000-0000-0000-000000000000'::uuid
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.require_hotel_id() RETURNS uuid
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  v uuid := platform.current_hotel_id();
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'tenant scope is not established for this transaction'
      USING ERRCODE = '42501';
  END IF;
  RETURN v;
END $$;
--> statement-breakpoint

-- ------------------------------------------------- payload sanitisation
-- CLAUDE.md §8. A top-level `?|` key test only inspects the outermost object, so
-- {"guest":{"registrationNumber":"..."}} would pass it. This walks the whole
-- document — nested objects and arrays at any depth — because that is exactly
-- where a leak hides.
CREATE OR REPLACE FUNCTION platform.denied_payload_keys() RETURNS text[]
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
  SELECT ARRAY[
    'password', 'passwordhash', 'otp', 'pin',
    'token', 'accesstoken', 'refreshtoken', 'sessiontoken', 'sessionid',
    'secret', 'apikey', 'webhooksecret', 'signature', 'privatekey',
    'pan', 'cvv', 'cvc', 'cardnumber',
    'registrationnumber', 'passportnumber', 'nationalid', 'foreignid',
    'smsbody', 'messagebody'
  ]
$$;
--> statement-breakpoint

-- Comparison is case- and separator-insensitive, so `registration_number`,
-- `registrationNumber` and `Registration-Number` are all the same key.
CREATE OR REPLACE FUNCTION platform.is_denied_key(p_key text) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
  SELECT lower(regexp_replace(p_key, '[^a-zA-Z0-9]', '', 'g')) = ANY(platform.denied_payload_keys())
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.contains_denied_key(p_payload jsonb)
  RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
DECLARE
  v_key text;
  v_value jsonb;
BEGIN
  IF p_payload IS NULL THEN
    RETURN false;
  END IF;

  IF jsonb_typeof(p_payload) = 'object' THEN
    FOR v_key, v_value IN SELECT * FROM jsonb_each(p_payload) LOOP
      IF platform.is_denied_key(v_key) THEN
        RETURN true;
      END IF;
      IF platform.contains_denied_key(v_value) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;

  IF jsonb_typeof(p_payload) = 'array' THEN
    FOR v_value IN SELECT * FROM jsonb_array_elements(p_payload) LOOP
      IF platform.contains_denied_key(v_value) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;

  RETURN false;
END
$$;
--> statement-breakpoint

-- ------------------------------------------------- append-only enforcement
-- ADR-0009 / 12-migration-strategy §5. A raising trigger is used rather than
-- `DO INSTEAD NOTHING` so the caller sees the refusal instead of a silent no-op.
CREATE OR REPLACE FUNCTION platform.reject_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only; % is not permitted',
    TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = '42501';
END $$;
--> statement-breakpoint

-- ---------------------------------------------------------- idempotency
CREATE TABLE platform.idempotency_key (
  idempotency_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id        uuid NOT NULL,
  realm           text NOT NULL,
  actor_ref       text NOT NULL,
  client_ref      text NOT NULL,
  operation       text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash    text NOT NULL,
  state           text NOT NULL DEFAULT 'in_progress',
  response_status integer,
  response_body   jsonb,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  expires_at      timestamptz NOT NULL,
  CONSTRAINT idempotency_state_known
    CHECK (state IN ('in_progress', 'succeeded', 'failed')),
  -- A terminal record always carries its canonical response; an in-flight one
  -- never does. This is what makes a replay either a stored result or a wait.
  CONSTRAINT idempotency_terminal_has_response CHECK (
    (state = 'in_progress' AND response_status IS NULL AND completed_at IS NULL)
    OR (state <> 'in_progress' AND response_status IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT idempotency_key_not_blank CHECK (length(idempotency_key) BETWEEN 8 AND 200)
);
--> statement-breakpoint

-- 04-logical-data-model §10: unique on (realm, actor, endpoint, key).
CREATE UNIQUE INDEX idempotency_key_scope_uq
  ON platform.idempotency_key (realm, actor_ref, operation, idempotency_key);
--> statement-breakpoint
CREATE INDEX idempotency_key_expiry_idx ON platform.idempotency_key (expires_at);
--> statement-breakpoint

-- ---------------------------------------------------------- outbox
-- D-05: 12-migration-strategy §5 requires the outbox to be append-only, while
-- 04-logical-data-model §10 gives it a delivery marker. Both hold once the
-- immutable event and its mutable delivery state are separate rows.
CREATE TABLE platform.outbox_event (
  event_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_uuid     uuid NOT NULL DEFAULT gen_random_uuid(),
  hotel_id       uuid NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id   text NOT NULL,
  event_type     text NOT NULL,
  event_version  integer NOT NULL DEFAULT 1,
  payload        jsonb NOT NULL,
  correlation_id text,
  causation_id   text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbox_event_uuid_uq UNIQUE (event_uuid),
  CONSTRAINT outbox_event_version_positive CHECK (event_version >= 1),
  -- CLAUDE.md §8: an outbox payload must never carry a secret or a full
  -- identifier. Enforced in the database, not only in review.
  CONSTRAINT outbox_payload_sanitised
    CHECK (NOT platform.contains_denied_key(payload))
);
--> statement-breakpoint

CREATE INDEX outbox_event_aggregate_idx
  ON platform.outbox_event (aggregate_type, aggregate_id, event_id);
--> statement-breakpoint

CREATE TRIGGER outbox_event_append_only
  BEFORE UPDATE OR DELETE ON platform.outbox_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER outbox_event_no_truncate
  BEFORE TRUNCATE ON platform.outbox_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE TABLE platform.outbox_delivery (
  event_id      bigint PRIMARY KEY
                  REFERENCES platform.outbox_event (event_id) ON DELETE RESTRICT,
  hotel_id      uuid NOT NULL,
  state         text NOT NULL DEFAULT 'pending',
  attempts      integer NOT NULL DEFAULT 0,
  available_at  timestamptz NOT NULL DEFAULT now(),
  claimed_by    text,
  claimed_until timestamptz,
  published_at  timestamptz,
  last_error    text,
  revision      integer NOT NULL DEFAULT 0,
  CONSTRAINT outbox_delivery_state_known
    CHECK (state IN ('pending', 'claimed', 'published', 'failed')),
  CONSTRAINT outbox_delivery_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT outbox_delivery_published_has_time CHECK (
    (state = 'published') = (published_at IS NOT NULL)
  )
);
--> statement-breakpoint

CREATE INDEX outbox_delivery_claimable_idx
  ON platform.outbox_delivery (available_at, event_id)
  WHERE state IN ('pending', 'claimed');
--> statement-breakpoint

-- An event with no delivery row would never be relayed. The pairing is a
-- database guarantee rather than a caller obligation.
-- SECURITY DEFINER so the *trigger* owns the write, not the caller.
--
-- Previously this ran with the caller's privileges, which forced a direct INSERT
-- grant on outbox_delivery for every runtime — a grant nothing legitimately used,
-- and one the ACL matrix could only "cover" by skipping the case. With the
-- trigger as definer the grant is gone and a direct INSERT is refused outright.
CREATE OR REPLACE FUNCTION platform.enqueue_outbox_delivery() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  INSERT INTO platform.outbox_delivery (event_id, hotel_id)
  VALUES (NEW.event_id, NEW.hotel_id);
  RETURN NEW;
END $$;
--> statement-breakpoint

ALTER FUNCTION platform.enqueue_outbox_delivery() OWNER TO prsystem_migrate;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.enqueue_outbox_delivery() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER outbox_event_enqueue
  AFTER INSERT ON platform.outbox_event
  FOR EACH ROW EXECUTE FUNCTION platform.enqueue_outbox_delivery();
--> statement-breakpoint

-- ---------------------------------------------------------- inbox
CREATE TABLE platform.inbox_consumption (
  consumption_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id          uuid NOT NULL,
  consumer          text NOT NULL,
  dedup_key         text NOT NULL,
  source            text NOT NULL,
  first_consumed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_consumption_uq UNIQUE (consumer, dedup_key)
);
--> statement-breakpoint

-- ---------------------------------------------------------- provider events
CREATE TABLE platform.provider_event (
  provider_event_row_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id          uuid NOT NULL,
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  event_kind        text NOT NULL,
  -- The payload itself is never stored. Only its digest, so a redelivery can be
  -- compared without keeping a provider body that may carry card or identity data.
  payload_hash      text NOT NULL,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT provider_event_uq UNIQUE (provider, provider_event_id),
  CONSTRAINT provider_event_hash_shape CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT provider_event_metadata_sanitised
    CHECK (NOT platform.contains_denied_key(metadata))
);
--> statement-breakpoint

-- ---------------------------------------------------------- jobs and exports
CREATE TABLE platform.job_run (
  job_run_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL,
  job_name    text NOT NULL,
  job_identity text NOT NULL,
  state       text NOT NULL DEFAULT 'running',
  scope       jsonb NOT NULL DEFAULT '{}'::jsonb,
  as_of       timestamptz,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_name  text,
  CONSTRAINT job_run_state_known CHECK (state IN ('running', 'succeeded', 'failed')),
  CONSTRAINT job_run_terminal_has_finish CHECK (
    (state = 'running') = (finished_at IS NULL)
  )
);
--> statement-breakpoint
CREATE INDEX job_run_name_idx ON platform.job_run (job_name, started_at DESC);
--> statement-breakpoint

-- Job rows are the authorisation input for cross-tenant maintenance, so the
-- fields that decide "may this run" must not be editable by the principal being
-- authorised. Column grants stop a worker naming a different job or a different
-- identity; this trigger stops the transitions those grants cannot express.
CREATE OR REPLACE FUNCTION platform.job_run_transition_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  -- Identity is fixed at creation. A job whose name or owner can change is a
  -- bearer token, not a record.
  IF NEW.job_run_id IS DISTINCT FROM OLD.job_run_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.job_name IS DISTINCT FROM OLD.job_name
     OR NEW.job_identity IS DISTINCT FROM OLD.job_identity
     OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION
      'job_run identity is immutable: job_run_id, hotel_id, job_name, job_identity and started_at cannot change'
      USING ERRCODE = '42501';
  END IF;

  -- Terminal is terminal. Without this a completed job could be reset to
  -- running and replayed, which is the same effect the idempotency rules exist
  -- to prevent.
  IF OLD.state <> 'running' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'job % is already %; a terminal job cannot transition to %',
      OLD.job_run_id, OLD.state, NEW.state USING ERRCODE = '22023';
  END IF;

  IF OLD.state = 'running' AND NEW.state NOT IN ('running', 'succeeded', 'failed') THEN
    RAISE EXCEPTION 'unknown job state %', NEW.state USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

ALTER FUNCTION platform.job_run_transition_guard() OWNER TO prsystem_migrate;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.job_run_transition_guard() FROM PUBLIC;
--> statement-breakpoint

CREATE TRIGGER job_run_transition_guard
  BEFORE UPDATE ON platform.job_run
  FOR EACH ROW EXECUTE FUNCTION platform.job_run_transition_guard();
--> statement-breakpoint

CREATE TABLE platform.export_artifact (
  export_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL,
  job_run_id   uuid REFERENCES platform.job_run (job_run_id),
  export_kind  text NOT NULL,
  storage_key  text NOT NULL,
  content_hash text NOT NULL,
  row_count    integer NOT NULL DEFAULT 0,
  as_of        timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  CONSTRAINT export_artifact_rows_non_negative CHECK (row_count >= 0),
  CONSTRAINT export_artifact_hash_shape CHECK (content_hash ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint

-- ------------------------------------------- projections (global, not tenant)
CREATE TABLE platform.projection_checkpoint (
  projection    text PRIMARY KEY,
  last_event_id bigint NOT NULL DEFAULT 0,
  as_of         timestamptz,
  status        text NOT NULL DEFAULT 'idle',
  updated_at    timestamptz NOT NULL DEFAULT now(),
  revision      integer NOT NULL DEFAULT 0,
  CONSTRAINT projection_status_known
    CHECK (status IN ('idle', 'running', 'rebuilding', 'failed')),
  CONSTRAINT projection_last_event_non_negative CHECK (last_event_id >= 0)
);
--> statement-breakpoint

-- ADR-0019 §3: a stale projection must be visibly stale.
CREATE VIEW platform.projection_freshness AS
SELECT
  projection,
  last_event_id,
  as_of,
  status,
  CASE WHEN as_of IS NULL THEN NULL
       ELSE GREATEST(0, floor(EXTRACT(EPOCH FROM (now() - as_of)))::bigint)
  END AS lag_seconds
FROM platform.projection_checkpoint;
--> statement-breakpoint

-- --------------------------------------- global reference and external gates
CREATE TABLE platform.external_gate (
  gate_code   text PRIMARY KEY,
  description text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  blocker     text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT external_gate_code_shape CHECK (gate_code ~ '^EXT-\d{2}$')
);
--> statement-breakpoint

-- Internal readiness controls. These are NOT external integration gates: the
-- EXT-01..EXT-11 namespace is fixed by docs/00 §4 and may not be reused for POS,
-- email or key management (Phase 03 review).
CREATE TABLE platform.internal_gate (
  control_code text PRIMARY KEY,
  description  text NOT NULL,
  enabled      boolean NOT NULL DEFAULT false,
  blocker      text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT internal_gate_code_shape CHECK (control_code ~ '^INT-[A-Z]{2,8}-\d{2}$')
);
--> statement-breakpoint

INSERT INTO platform.internal_gate (control_code, description, blocker) VALUES
  ('INT-KMS-01', 'Approved key management service adapter', 'no KMS provider contracted; production fails closed'),
  ('INT-POS-01', 'Hotel POS terminal integration', 'no POS vendor contracted'),
  ('INT-MAIL-01', 'Transactional email delivery provider', 'no email provider contracted');
--> statement-breakpoint

CREATE TABLE platform.feature_flag (
  flag_key    text PRIMARY KEY,
  description text NOT NULL,
  enabled     boolean NOT NULL DEFAULT false,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- CLAUDE.md §9: every external gate is closed until its contract clears, and the
-- adapter stays disabled. Seeded closed; Phase 20 flips them with evidence.
INSERT INTO platform.external_gate (gate_code, description, blocker) VALUES
  ('EXT-01', 'XYP / ХУР identity verification', 'contract, credentials and legal basis not issued'),
  ('EXT-02', 'e-Mongolia guest authentication', 'contract, credentials and legal basis not issued'),
  ('EXT-03', 'QPay payment provider', 'contract, credentials and legal basis not issued'),
  ('EXT-04', 'Khaan Bank gateway and POS', 'contract, credentials and legal basis not issued'),
  ('EXT-05', 'CallPro SMS', 'contract, credentials and legal basis not issued'),
  ('EXT-06', 'Google Maps', 'contract, credentials and legal basis not issued'),
  ('EXT-07', 'Platform central account and settlement authorisation', 'authorisation not granted'),
  ('EXT-08', 'Personal-data and privacy governance', 'authorisation not granted'),
  ('EXT-09', 'ЦЕГ Police data-sharing authorisation', 'authorisation not granted'),
  ('EXT-10', 'Police security approvals', 'authorisation not granted'),
  ('EXT-11', 'eBarimt receipting', 'contract, credentials and legal basis not issued');
--> statement-breakpoint

-- ---------------------------------------------------------- operational alerts
CREATE TABLE platform.operational_alert (
  alert_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_code  text NOT NULL,
  severity    text NOT NULL,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  raised_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT operational_alert_severity_known
    CHECK (severity IN ('info', 'warning', 'critical'))
);
--> statement-breakpoint
CREATE INDEX operational_alert_open_idx
  ON platform.operational_alert (alert_code, raised_at DESC)
  WHERE resolved_at IS NULL;
--> statement-breakpoint

-- ---------------------------------------------------------- audit streams
-- ADR-0018 §3: partition key is the server-generated occurred_at, never a
-- client-supplied or business-effective time.
CREATE TABLE audit.platform_event (
  event_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  realm          text NOT NULL,
  action         text NOT NULL,
  outcome        text NOT NULL,
  actor_ref      text,
  hotel_id       uuid,
  target_type    text,
  target_ref     text,
  reason         text,
  correlation_id text,
  causation_id   text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT platform_event_pk PRIMARY KEY (occurred_at, event_id),
  CONSTRAINT platform_event_outcome_known
    CHECK (outcome IN ('allowed', 'denied', 'failed')),
  CONSTRAINT platform_event_payload_sanitised
    CHECK (NOT platform.contains_denied_key(payload))
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint

CREATE TABLE police_audit.security_event (
  event_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  action         text NOT NULL,
  outcome        text NOT NULL,
  actor_ref      text,
  case_ref       text,
  reason         text,
  correlation_id text,
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT security_event_pk PRIMARY KEY (occurred_at, event_id),
  CONSTRAINT security_event_outcome_known
    CHECK (outcome IN ('allowed', 'denied', 'failed')),
  CONSTRAINT security_event_payload_sanitised
    CHECK (NOT platform.contains_denied_key(payload))
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint

CREATE TRIGGER platform_event_append_only
  BEFORE UPDATE OR DELETE ON audit.platform_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER security_event_append_only
  BEFORE UPDATE OR DELETE ON police_audit.security_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- ---------------------------------------------------------- partitioning
-- ADR-0018 §4. Hardened after the Phase 03 review: the function is an allow-list
-- over exactly the two audit streams, bounds the month count, fixes its
-- search_path, fully qualifies every object, and serialises creation with an
-- advisory lock. It is SECURITY DEFINER owned by a narrow partition-manager role,
-- so the worker can extend coverage without ever holding schema DDL rights.
CREATE OR REPLACE FUNCTION platform.ensure_month_partitions(
  p_schema text,
  p_table  text,
  p_from   timestamptz,
  p_months integer
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_start date;
  v_created integer := 0;
  i integer;
  v_lower date;
  v_upper date;
  v_name text;
BEGIN
  -- Allow-list, not validation. A caller cannot name any other relation, so the
  -- function can never be turned into a general CREATE TABLE primitive.
  IF NOT (p_schema = 'audit' AND p_table = 'platform_event')
     AND NOT (p_schema = 'police_audit' AND p_table = 'security_event') THEN
    RAISE EXCEPTION 'ensure_month_partitions refuses %.%; only the two audit streams are permitted',
      p_schema, p_table USING ERRCODE = '42501';
  END IF;

  IF p_months IS NULL OR p_months < 1 OR p_months > 24 THEN
    RAISE EXCEPTION 'p_months must be between 1 and 24' USING ERRCODE = '22023';
  END IF;

  IF p_from IS NULL THEN
    RAISE EXCEPTION 'p_from is required' USING ERRCODE = '22023';
  END IF;

  -- Two runners extending the same stream would otherwise race on CREATE TABLE.
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('prsystem.partition.' || p_schema || '.' || p_table)
  );

  v_start := pg_catalog.date_trunc('month', p_from AT TIME ZONE 'UTC')::date;

  FOR i IN 0 .. p_months - 1 LOOP
    v_lower := (v_start + (i || ' months')::interval)::date;
    v_upper := (v_lower + interval '1 month')::date;
    v_name  := pg_catalog.format('%s_%s', p_table, pg_catalog.to_char(v_lower, 'YYYY_MM'));

    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = p_schema AND c.relname = v_name
    ) THEN
      EXECUTE pg_catalog.format(
        'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
        p_schema, v_name, p_schema, p_table, v_lower, v_upper
      );

      -- A new partition inherits nothing automatically. Owner, grants and
      -- TRUNCATE protection are re-established explicitly, or a partition
      -- created next month would be less protected than the ones created here.
      EXECUTE pg_catalog.format(
        'ALTER TABLE %I.%I OWNER TO prsystem_partition_mgr', p_schema, v_name
      );
      EXECUTE pg_catalog.format('REVOKE ALL ON %I.%I FROM PUBLIC', p_schema, v_name);
      EXECUTE pg_catalog.format(
        'GRANT SELECT ON %I.%I TO %I',
        p_schema, v_name,
        CASE WHEN p_schema = 'audit' THEN 'prsystem_audit_reader'
             ELSE 'prsystem_police_audit_reader' END
      );
      EXECUTE pg_catalog.format(
        'GRANT INSERT ON %I.%I TO prsystem_audit_writer', p_schema, v_name
      );
      EXECUTE pg_catalog.format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I
           FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()',
        v_name || '_no_truncate', p_schema, v_name
      );

      v_created := v_created + 1;
    END IF;
  END LOOP;

  RETURN v_created;
END
$$;
--> statement-breakpoint

ALTER FUNCTION platform.ensure_month_partitions(text, text, timestamptz, integer)
  OWNER TO prsystem_partition_mgr;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.ensure_month_partitions(text, text, timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint

-- Months of pre-created coverage still ahead of now, counting the current month.
CREATE OR REPLACE FUNCTION platform.partition_horizon(
  p_schema text,
  p_table  text
) RETURNS integer
  LANGUAGE plpgsql STABLE
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_months integer := 0;
  v_probe  date := pg_catalog.date_trunc('month', pg_catalog.now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF NOT (p_schema = 'audit' AND p_table = 'platform_event')
     AND NOT (p_schema = 'police_audit' AND p_table = 'security_event') THEN
    RAISE EXCEPTION 'partition_horizon refuses %.%', p_schema, p_table USING ERRCODE = '42501';
  END IF;

  LOOP
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = p_schema
        AND c.relname = pg_catalog.format('%s_%s', p_table, pg_catalog.to_char(v_probe, 'YYYY_MM'))
    );
    v_months := v_months + 1;
    v_probe := (v_probe + interval '1 month')::date;
  END LOOP;
  RETURN v_months;
END
$$;
--> statement-breakpoint
ALTER FUNCTION platform.partition_horizon(text, text) OWNER TO prsystem_partition_mgr;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.partition_horizon(text, text) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.check_partition_horizon(
  p_threshold integer DEFAULT 3
) RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_raised integer := 0;
  r record;
  v_horizon integer;
BEGIN
  IF p_threshold IS NULL OR p_threshold < 1 OR p_threshold > 24 THEN
    RAISE EXCEPTION 'p_threshold must be between 1 and 24' USING ERRCODE = '22023';
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('audit', 'platform_event'),
      ('police_audit', 'security_event')
    ) AS t(schema_name, table_name)
  LOOP
    v_horizon := platform.partition_horizon(r.schema_name, r.table_name);
    IF v_horizon < p_threshold THEN
      INSERT INTO platform.operational_alert (alert_code, severity, detail)
      VALUES (
        'AUDIT_PARTITION_HORIZON',
        'critical',
        pg_catalog.jsonb_build_object(
          'schema', r.schema_name,
          'table', r.table_name,
          'horizonMonths', v_horizon,
          'thresholdMonths', p_threshold
        )
      );
      v_raised := v_raised + 1;
    END IF;
  END LOOP;
  RETURN v_raised;
END
$$;
--> statement-breakpoint
ALTER FUNCTION platform.check_partition_horizon(integer) OWNER TO prsystem_partition_mgr;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.check_partition_horizon(integer) FROM PUBLIC;
--> statement-breakpoint

-- --------------------------------------------------- audit append functions
-- Runtime roles hold NO privilege on an audit table — not INSERT, not SELECT.
-- They call these SECURITY DEFINER wrappers, which derive server time, realm,
-- actor and tenant scope from the trusted transaction context rather than
-- accepting them from the caller. A caller cannot forge an actor, backdate a
-- record, or write into the other realm's stream.
CREATE OR REPLACE FUNCTION audit.append_platform_audit_event(
  p_action      text,
  p_outcome     text,
  p_target_type text DEFAULT NULL,
  p_target_ref  text DEFAULT NULL,
  p_reason      text DEFAULT NULL,
  p_payload     jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event_id uuid := gen_random_uuid();
  v_realm text := platform.current_realm();
  v_actor text := platform.current_actor_ref();
  v_hotel uuid := platform.current_hotel_id();
BEGIN
  IF p_action IS NULL OR pg_catalog.length(p_action) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'audit action is required' USING ERRCODE = '22023';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('allowed', 'denied', 'failed') THEN
    RAISE EXCEPTION 'audit outcome must be allowed, denied or failed' USING ERRCODE = '22023';
  END IF;
  IF v_realm IS NULL OR v_actor IS NULL OR v_hotel IS NULL THEN
    RAISE EXCEPTION 'audit requires an established transaction context' USING ERRCODE = '42501';
  END IF;
  -- The Police stream is a separate function writing a separate table. Both
  -- append functions share the approved `prsystem_audit_writer` owner (ADR-0018);
  -- separation comes from this realm check and from realm-separated EXECUTE
  -- grants, not from ownership. A Police action must not be recorded here.
  IF v_realm = 'police' THEN
    RAISE EXCEPTION 'police realm must use police_audit.append_police_security_event'
      USING ERRCODE = '42501';
  END IF;
  IF platform.contains_denied_key(p_payload) THEN
    RAISE EXCEPTION 'audit payload carries a denied field' USING ERRCODE = '22023';
  END IF;

  INSERT INTO audit.platform_event
    (event_id, occurred_at, realm, action, outcome, actor_ref, hotel_id,
     target_type, target_ref, reason, correlation_id, causation_id, payload)
  VALUES
    (v_event_id, pg_catalog.now(), v_realm, p_action, p_outcome, v_actor, v_hotel,
     p_target_type, p_target_ref, p_reason,
     nullif(pg_catalog.current_setting('app.correlation_id', true), ''),
     nullif(pg_catalog.current_setting('app.causation_id', true), ''),
     coalesce(p_payload, '{}'::jsonb));

  RETURN v_event_id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION audit.append_platform_audit_event(text, text, text, text, text, jsonb)
  OWNER TO prsystem_audit_writer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit.append_platform_audit_event(text, text, text, text, text, jsonb) FROM PUBLIC;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION police_audit.append_police_security_event(
  p_action   text,
  p_outcome  text,
  p_case_ref text DEFAULT NULL,
  p_reason   text DEFAULT NULL,
  p_payload  jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_event_id uuid := gen_random_uuid();
  v_realm text := platform.current_realm();
  v_actor text := platform.current_actor_ref();
BEGIN
  IF p_action IS NULL OR pg_catalog.length(p_action) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'audit action is required' USING ERRCODE = '22023';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('allowed', 'denied', 'failed') THEN
    RAISE EXCEPTION 'audit outcome must be allowed, denied or failed' USING ERRCODE = '22023';
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'audit requires an established transaction context' USING ERRCODE = '42501';
  END IF;
  IF v_realm IS DISTINCT FROM 'police' THEN
    RAISE EXCEPTION 'only the police realm may write the police security stream'
      USING ERRCODE = '42501';
  END IF;
  IF platform.contains_denied_key(p_payload) THEN
    RAISE EXCEPTION 'audit payload carries a denied field' USING ERRCODE = '22023';
  END IF;

  INSERT INTO police_audit.security_event
    (event_id, occurred_at, action, outcome, actor_ref, case_ref, reason, correlation_id, payload)
  VALUES
    (v_event_id, pg_catalog.now(), p_action, p_outcome, v_actor, p_case_ref, p_reason,
     nullif(pg_catalog.current_setting('app.correlation_id', true), ''),
     coalesce(p_payload, '{}'::jsonb));

  RETURN v_event_id;
END
$$;
--> statement-breakpoint
-- Both append functions share this owner by approved design (ADR-0018): it is an
-- infrastructure role with INSERT and no SELECT on either stream, which no
-- runtime can assume. Realm separation is enforced by the realm check inside each
-- function and by realm-separated EXECUTE grants — not by having two owners.
ALTER FUNCTION police_audit.append_police_security_event(text, text, text, text, jsonb)
  OWNER TO prsystem_audit_writer;
--> statement-breakpoint
REVOKE ALL ON FUNCTION police_audit.append_police_security_event(text, text, text, text, jsonb) FROM PUBLIC;
--> statement-breakpoint

-- ------------------------------------------- cross-tenant maintenance surface
-- ADR-0017 §8. A cross-tenant job establishes scope per tenant rather than
-- bypassing RLS: the owner of this function holds no BYPASSRLS, so the only way
-- it can see a tenant's rows is to set that tenant's scope.
--
-- The audit reference is **generated here**, not supplied by the caller: a
-- reference the caller invents is not evidence of anything. The immutable record
-- is the row in audit.platform_event; platform.operational_alert is telemetry
-- and carries the generated audit id so an operator can find that record.
--
-- Deletion and audit share one transaction, so a failure to record the audit
-- rolls the deletion back (ADR-0018 §5).
-- The job name this operation is allowed to run under. A job row of any other
-- kind is not authorisation for this deletion.
CREATE OR REPLACE FUNCTION platform.maintenance_job_name() RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT 'platform.maintenance.expire_idempotency_keys'::text
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.maintenance_expire_idempotency_keys(
  p_job_run_id uuid
) RETURNS TABLE (deleted integer, audit_event_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  v_deleted integer;
  v_audit_event_id uuid;
  v_hotel uuid := platform.current_hotel_id();
  v_realm text := platform.current_realm();
  v_actor text := platform.current_actor_ref();
  v_correlation text := nullif(pg_catalog.current_setting('app.correlation_id', true), '');
  v_job record;
BEGIN
  IF v_hotel IS NULL OR v_actor IS NULL OR v_realm IS NULL OR v_correlation IS NULL THEN
    RAISE EXCEPTION
      'maintenance requires an established transaction context (hotel, realm, actor, correlation)'
      USING ERRCODE = '42501';
  END IF;

  IF v_realm = 'police' THEN
    RAISE EXCEPTION 'the police realm may not run platform maintenance' USING ERRCODE = '42501';
  END IF;

  IF p_job_run_id IS NULL THEN
    RAISE EXCEPTION 'maintenance requires a running job identity' USING ERRCODE = '22023';
  END IF;

  -- FOR UPDATE, and only a *running* job of exactly this kind belonging to this
  -- tenant. The lock is what makes two concurrent invocations sharing one job
  -- impossible: the second waits, then finds the job no longer running.
  SELECT * INTO v_job
    FROM platform.job_run
   WHERE job_run_id = p_job_run_id AND hotel_id = v_hotel
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'no job_run % for this tenant', p_job_run_id USING ERRCODE = '22023';
  END IF;
  IF v_job.job_name IS DISTINCT FROM platform.maintenance_job_name() THEN
    RAISE EXCEPTION 'job % is a % job, not %',
      p_job_run_id, v_job.job_name, platform.maintenance_job_name() USING ERRCODE = '22023';
  END IF;
  IF v_job.state IS DISTINCT FROM 'running' THEN
    RAISE EXCEPTION 'job % is already %; a completed job cannot be replayed',
      p_job_run_id, v_job.state USING ERRCODE = '22023';
  END IF;
  -- The job must belong to the actor running it, or a job row becomes a bearer
  -- token any actor could present.
  IF v_job.job_identity IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'job % belongs to another actor', p_job_run_id USING ERRCODE = '42501';
  END IF;

  DELETE FROM platform.idempotency_key
   WHERE hotel_id = v_hotel AND expires_at < pg_catalog.now() AND state <> 'in_progress';
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Immutable audit, same transaction. If this raises, the delete above and the
  -- job transition below are both undone.
  v_audit_event_id := audit.append_platform_audit_event(
    platform.maintenance_job_name(),
    'allowed',
    'job_run',
    p_job_run_id::text,
    v_job.job_name,
    pg_catalog.jsonb_build_object('rows', v_deleted)
  );

  UPDATE platform.job_run
     SET state = 'succeeded', finished_at = pg_catalog.now()
   WHERE job_run_id = p_job_run_id;

  -- Telemetry, carrying the generated audit id. Not the audit record itself.
  INSERT INTO platform.operational_alert (alert_code, severity, detail)
  VALUES ('MAINTENANCE_RUN', 'info',
          pg_catalog.jsonb_build_object('operation', 'expire_idempotency_keys',
                                        'jobRunId', p_job_run_id,
                                        'jobName', v_job.job_name,
                                        'auditEventId', v_audit_event_id,
                                        'rows', v_deleted));

  RETURN QUERY SELECT v_deleted, v_audit_event_id;
END
$$;
--> statement-breakpoint
ALTER FUNCTION platform.maintenance_expire_idempotency_keys(uuid)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.maintenance_expire_idempotency_keys(uuid) FROM PUBLIC;
--> statement-breakpoint

-- ---------------------------------------------------------- row level security
-- ADR-0017 §1: FORCE so the owner is subject to the policy too.
ALTER TABLE platform.idempotency_key   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.idempotency_key   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.outbox_event      ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.outbox_event      FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.outbox_delivery   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.outbox_delivery   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.inbox_consumption ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.inbox_consumption FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.provider_event    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.provider_event    FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.job_run           ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.job_run           FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.export_artifact   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.export_artifact   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON platform.idempotency_key
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.outbox_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.outbox_delivery
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.inbox_consumption
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.provider_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.job_run
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.export_artifact
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- ---------------------------------------------------------- ownership
-- The two audit streams belong to the partition manager. PostgreSQL requires
-- the parent's owner to attach a partition, so the renewal function's definer
-- and the tables' owner must be the same role — and that role owns nothing else.
ALTER TABLE audit.platform_event OWNER TO prsystem_partition_mgr;
--> statement-breakpoint
ALTER TABLE police_audit.security_event OWNER TO prsystem_partition_mgr;
--> statement-breakpoint
-- Every kernel object is owned by the DDL role. No runtime role owns anything:
-- an owner can disable a trigger, alter a policy or drop a table, so ownership
-- is the privilege that matters most here.
ALTER SCHEMA platform     OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER SCHEMA audit        OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER SCHEMA police_audit OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER SCHEMA police       OWNER TO prsystem_migrate;
--> statement-breakpoint

-- ---------------------------------------------------------- grants
-- PUBLIC gets nothing anywhere in the kernel.
REVOKE ALL ON ALL TABLES IN SCHEMA platform FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA audit FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA police_audit FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA platform FROM PUBLIC;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE ON platform.idempotency_key TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.outbox_event TO prsystem_api, prsystem_worker;
--> statement-breakpoint
-- No INSERT: delivery rows are created only by the append-only event trigger.
-- The relay is a worker concern. The API has no code path that claims, publishes
-- or fails a delivery, so it holds read visibility only; the worker keeps the
-- UPDATE its claim/CAS/publish/fail transitions actually need.
GRANT SELECT ON platform.outbox_delivery TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE ON platform.outbox_delivery TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.inbox_consumption TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.provider_event TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.job_run, platform.export_artifact TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.export_artifact TO prsystem_worker;
--> statement-breakpoint
-- Column-scoped, not table-wide. The worker records how its own job ended; it
-- cannot restate which job it was or whose identity it ran under, which is what
-- platform.maintenance_expire_idempotency_keys authorises on.
GRANT SELECT, INSERT ON platform.job_run TO prsystem_worker;
--> statement-breakpoint
GRANT UPDATE (state, finished_at, error_name, as_of) ON platform.job_run TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.projection_checkpoint, platform.projection_freshness
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT INSERT, UPDATE ON platform.projection_checkpoint TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.external_gate, platform.internal_gate, platform.feature_flag
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.operational_alert TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.operational_alert TO prsystem_worker;
--> statement-breakpoint
GRANT INSERT ON platform.operational_alert TO prsystem_partition_mgr, prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT, DELETE ON platform.idempotency_key TO prsystem_maintenance_fn;
--> statement-breakpoint

-- The audit streams.
--
-- No runtime role holds ANY table privilege here. Appending is the wrapper
-- function; reading belongs to the dedicated reader for that stream and to
-- nobody else. `prsystem_maintenance` is deliberately absent: it is break-glass,
-- and break-glass is a DBA action with its own audit trail, not a standing grant.
GRANT INSERT ON audit.platform_event TO prsystem_audit_writer;
--> statement-breakpoint
GRANT INSERT ON police_audit.security_event TO prsystem_audit_writer;
--> statement-breakpoint
GRANT SELECT ON audit.platform_event TO prsystem_audit_reader;
--> statement-breakpoint
GRANT SELECT ON police_audit.security_event TO prsystem_police_audit_reader;
--> statement-breakpoint

-- Execution rights: named functions only, never a schema-wide grant.
GRANT EXECUTE ON FUNCTION
  platform.current_hotel_id(), platform.current_realm(), platform.current_actor_ref(),
  platform.platform_scope(), platform.require_hotel_id(),
  platform.contains_denied_key(jsonb), platform.is_denied_key(text),
  platform.denied_payload_keys()
  TO prsystem_api, prsystem_worker, prsystem_police;
--> statement-breakpoint
-- Each SECURITY DEFINER owner needs EXECUTE on the helpers its own body calls.
-- Schema-wide REVOKE FROM PUBLIC removed the default, so these are explicit:
-- the append functions evaluate the sanitisation check, and the partition
-- manager attaches the append-only trigger.
GRANT EXECUTE ON FUNCTION
  platform.contains_denied_key(jsonb), platform.is_denied_key(text),
  platform.denied_payload_keys(), platform.current_realm(),
  platform.current_actor_ref(), platform.current_hotel_id()
  TO prsystem_audit_writer;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.reject_mutation() TO prsystem_partition_mgr;
--> statement-breakpoint
-- The maintenance definer works *through* the RLS policy rather than around it,
-- so it must be able to evaluate the policy's context function.
GRANT EXECUTE ON FUNCTION platform.current_hotel_id() TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.partition_horizon(text, text) TO prsystem_partition_mgr;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION audit.append_platform_audit_event(text, text, text, text, text, jsonb)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION police_audit.append_police_security_event(text, text, text, text, jsonb)
  TO prsystem_police;
--> statement-breakpoint
-- The worker extends audit coverage through the wrapper and gains no DDL by it.
-- The migration seeds the first partitions through the same function the worker
-- uses later, so the initial partitions and every future one are created by
-- identical code with identical ownership and grants.
GRANT EXECUTE ON FUNCTION
  platform.ensure_month_partitions(text, text, timestamptz, integer),
  platform.partition_horizon(text, text),
  platform.check_partition_horizon(integer)
  TO prsystem_worker, prsystem_migrate;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.maintenance_expire_idempotency_keys(uuid) TO prsystem_worker;
--> statement-breakpoint
-- The maintenance definer writes its own immutable audit record and reads the
-- job row it locks, so it needs those two rights and no others.
-- USAGE only: the definer writes its own immutable audit record through the
-- wrapper and holds no table privilege on the stream.
GRANT USAGE ON SCHEMA audit TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION audit.append_platform_audit_event(text, text, text, text, text, jsonb)
  TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT ON platform.job_run TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT UPDATE (state, finished_at, error_name) ON platform.job_run TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.current_realm(), platform.current_actor_ref(),
  platform.maintenance_job_name()
  TO prsystem_maintenance_fn;
--> statement-breakpoint

-- Created last, so every partition is stamped with the ownership, grants and
-- TRUNCATE protection settled above — exactly as a partition created next month
-- will be.
SELECT platform.ensure_month_partitions('audit', 'platform_event', now(), 4);
--> statement-breakpoint
SELECT platform.ensure_month_partitions('police_audit', 'security_event', now(), 4);
--> statement-breakpoint

-- ---------------------------------------------------- final privilege trim
-- CREATE on a schema is needed only to *own* an object there. Once ownership is
-- settled, the audit writer and the maintenance definer need none — the next
-- migration re-grants it at the top of this file if it must transfer ownership
-- again. The partition manager keeps CREATE on the two audit schemas, because
-- attaching next month's partition is exactly that privilege.
REVOKE CREATE ON SCHEMA platform FROM prsystem_audit_writer, prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA audit, police_audit FROM prsystem_audit_writer;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA platform FROM prsystem_partition_mgr;
