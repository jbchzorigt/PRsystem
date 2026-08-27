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

-- ---------------------------------------------------------------- roles
-- Cluster-scoped, so creation is idempotent. These are NOLOGIN group roles:
-- a deployment creates one login user per runtime and grants it the role, so no
-- credential is ever invented here (CLAUDE.md §8).
-- Roles and their attributes live in a cluster-wide catalog, not in this
-- database. Both loops therefore (a) tolerate a concurrent creator and (b) write
-- only when the current state actually differs — re-applying the journal, or
-- migrating two databases at once, must not contend for the same catalog tuple.
--
-- ADR-0017 §5: only the maintenance role may bypass RLS, and only under a named
-- audited job. Every other role is explicitly held at NOBYPASSRLS, so a
-- hand-granted attribute cannot survive a migration.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      ('prsystem_migrate', false),
      ('prsystem_api', false),
      ('prsystem_worker', false),
      ('prsystem_police', false),
      ('prsystem_maintenance', true),
      ('prsystem_audit_reader', false),
      ('prsystem_police_audit_reader', false)
    ) AS t(role_name, wants_bypassrls)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r.role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', r.role_name);
      EXCEPTION WHEN duplicate_object THEN
        -- Another migration created it between the check and the CREATE.
        NULL;
      END;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_roles
       WHERE rolname = r.role_name AND rolbypassrls IS DISTINCT FROM r.wants_bypassrls
    ) THEN
      EXECUTE format(
        'ALTER ROLE %I %s',
        r.role_name,
        CASE WHEN r.wants_bypassrls THEN 'BYPASSRLS' ELSE 'NOBYPASSRLS' END
      );
    END IF;
  END LOOP;
END $$;
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

GRANT USAGE ON SCHEMA platform TO prsystem_api, prsystem_worker, prsystem_maintenance;
--> statement-breakpoint
GRANT USAGE ON SCHEMA audit TO prsystem_api, prsystem_worker, prsystem_maintenance, prsystem_audit_reader;
--> statement-breakpoint
GRANT USAGE ON SCHEMA police_audit TO prsystem_police, prsystem_police_audit_reader, prsystem_maintenance;
--> statement-breakpoint
GRANT USAGE ON SCHEMA police TO prsystem_police, prsystem_maintenance;
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
  CONSTRAINT outbox_payload_sanitised CHECK (
    NOT (payload ?| ARRAY[
      'password', 'otp', 'token', 'accessToken', 'refreshToken', 'secret',
      'apiKey', 'signature', 'pan', 'cvv', 'cardNumber',
      'registrationNumber', 'passportNumber', 'smsBody'
    ])
  )
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
CREATE OR REPLACE FUNCTION platform.enqueue_outbox_delivery() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO platform.outbox_delivery (event_id, hotel_id)
  VALUES (NEW.event_id, NEW.hotel_id);
  RETURN NEW;
END $$;
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
  CONSTRAINT provider_event_metadata_sanitised CHECK (
    NOT (metadata ?| ARRAY[
      'pan', 'cvv', 'cardNumber', 'password', 'otp', 'token', 'secret',
      'apiKey', 'signature', 'registrationNumber', 'passportNumber', 'smsBody'
    ])
  )
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
  ('EXT-01', 'QPay payment provider', 'contract and credentials not issued'),
  ('EXT-02', 'Khaan Bank settlement', 'contract and credentials not issued'),
  ('EXT-03', 'POS integration', 'contract and credentials not issued'),
  ('EXT-04', 'eBarimt receipting', 'contract and credentials not issued'),
  ('EXT-05', 'CallPro SMS', 'contract and credentials not issued'),
  ('EXT-06', 'Email delivery provider', 'contract and credentials not issued'),
  ('EXT-07', 'Google Maps', 'contract and credentials not issued'),
  ('EXT-08', 'XYP/HUR identity verification', 'contract and credentials not issued'),
  ('EXT-09', 'ЦЕГ Police integration', 'contract and credentials not issued'),
  ('EXT-10', 'Key management service', 'contract and credentials not issued'),
  ('EXT-11', 'eMongolia', 'contract and credentials not issued');
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
  CONSTRAINT platform_event_payload_sanitised CHECK (
    NOT (payload ?| ARRAY[
      'password', 'otp', 'token', 'accessToken', 'refreshToken', 'secret',
      'apiKey', 'signature', 'pan', 'cvv', 'cardNumber',
      'registrationNumber', 'passportNumber', 'smsBody'
    ])
  )
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
  CONSTRAINT security_event_payload_sanitised CHECK (
    NOT (payload ?| ARRAY[
      'password', 'otp', 'token', 'secret', 'apiKey', 'signature',
      'registrationNumber', 'passportNumber', 'smsBody'
    ])
  )
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
-- ADR-0018 §4. Partitions are pre-created; a missing one is an operational
-- incident surfaced by the horizon check before any write can fail.
CREATE OR REPLACE FUNCTION platform.ensure_month_partitions(
  p_schema text,
  p_table  text,
  p_from   timestamptz,
  p_months integer
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_start date := date_trunc('month', p_from AT TIME ZONE 'UTC')::date;
  v_created integer := 0;
  i integer;
  v_lower date;
  v_upper date;
  v_name text;
BEGIN
  IF p_months < 1 THEN
    RAISE EXCEPTION 'p_months must be at least 1';
  END IF;

  FOR i IN 0 .. p_months - 1 LOOP
    v_lower := (v_start + (i || ' months')::interval)::date;
    v_upper := (v_lower + interval '1 month')::date;
    v_name  := format('%s_%s', p_table, to_char(v_lower, 'YYYY_MM'));

    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = p_schema AND c.relname = v_name
    ) THEN
      EXECUTE format(
        'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
        p_schema, v_name, p_schema, p_table, v_lower, v_upper
      );
      -- TRUNCATE triggers cannot live on the partitioned parent, so each
      -- partition carries its own. Privileges are the primary control; this is
      -- the second one.
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE TRUNCATE ON %I.%I
           FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()',
        v_name || '_no_truncate', p_schema, v_name
      );
      v_created := v_created + 1;
    END IF;
  END LOOP;

  RETURN v_created;
END $$;
--> statement-breakpoint

-- Months of pre-created coverage still ahead of now, counting the current month.
CREATE OR REPLACE FUNCTION platform.partition_horizon(
  p_schema text,
  p_table  text
) RETURNS integer LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_months integer := 0;
  v_probe  date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
BEGIN
  LOOP
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = p_schema
        AND c.relname = format('%s_%s', p_table, to_char(v_probe, 'YYYY_MM'))
    );
    v_months := v_months + 1;
    v_probe := (v_probe + interval '1 month')::date;
  END LOOP;
  RETURN v_months;
END $$;
--> statement-breakpoint

-- Raises an alert row when coverage falls below the threshold. Detection happens
-- before a write fails, which is the whole point of ADR-0018 §4.
CREATE OR REPLACE FUNCTION platform.check_partition_horizon(
  p_threshold integer DEFAULT 3
) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  v_raised integer := 0;
  r record;
  v_horizon integer;
BEGIN
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
        jsonb_build_object(
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
END $$;
--> statement-breakpoint

SELECT platform.ensure_month_partitions('audit', 'platform_event', now(), 4);
--> statement-breakpoint
SELECT platform.ensure_month_partitions('police_audit', 'security_event', now(), 4);
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

-- ---------------------------------------------------------- grants
GRANT SELECT, INSERT, UPDATE ON platform.idempotency_key TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.outbox_event TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.outbox_delivery TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.inbox_consumption TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.provider_event TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.job_run, platform.export_artifact TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.job_run, platform.export_artifact TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.projection_checkpoint, platform.projection_freshness
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT INSERT, UPDATE ON platform.projection_checkpoint TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.external_gate, platform.feature_flag TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.operational_alert TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.operational_alert TO prsystem_worker;
--> statement-breakpoint
GRANT ALL ON ALL TABLES IN SCHEMA platform TO prsystem_maintenance;
--> statement-breakpoint

-- Audit: business runtime roles append and cannot read; a dedicated reader role
-- reads and cannot write. Stricter than ADR-0018 §2 by customer direction.
GRANT INSERT ON audit.platform_event TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON audit.platform_event TO prsystem_audit_reader;
--> statement-breakpoint
GRANT INSERT ON police_audit.security_event TO prsystem_police;
--> statement-breakpoint
GRANT SELECT ON police_audit.security_event TO prsystem_police_audit_reader;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit.platform_event TO prsystem_maintenance;
--> statement-breakpoint
GRANT SELECT, INSERT ON police_audit.security_event TO prsystem_maintenance;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION
  platform.current_hotel_id(), platform.current_realm(), platform.current_actor_ref(),
  platform.platform_scope(), platform.require_hotel_id()
  TO prsystem_api, prsystem_worker, prsystem_police, prsystem_maintenance;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  platform.ensure_month_partitions(text, text, timestamptz, integer),
  platform.partition_horizon(text, text),
  platform.check_partition_horizon(integer)
  TO prsystem_worker, prsystem_maintenance;
