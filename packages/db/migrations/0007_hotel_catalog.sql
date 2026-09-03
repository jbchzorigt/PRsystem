-- Hotel catalog: room categories, physical rooms, stay tariffs, and the entity
-- lifecycle room, category, minibar product and minibar template share.
--
-- Three structural rules run through this migration.
--
-- **A rate is resolved, never invented.** Every tariff column is nullable and
-- nullable means *unset*, not zero. The hotel default is the last level of both
-- chains, so a hotel that has configured no default for a stay type has no
-- effective price and the API refuses the confirmation rather than pricing it at
-- nothing (`STAY-DEC-005`, doc 07 §2.1). Hourly and nightly are separate columns
-- at every level because the two are resolved independently.
--
-- **A snapshot is not configuration.** `stay_rate_snapshot` is append-only: no
-- role holds UPDATE or DELETE and a trigger refuses both. A later tariff edit
-- therefore cannot reprice a confirmed booking or an active stay, and the row
-- carries the source level, the source entity and the configuration version the
-- price came from, so the calculation can be re-proved (`STAY-DEC-005`,
-- `RML-DEC-004`, doc 05 §13.2).
--
-- **`RETIRING` is the server's word, not the client's.** A creating statement may
-- name `ACTIVE` or `INACTIVE` and nothing else; `RETIRING` exists only as the
-- outcome of a deactivation request the server accepted, and the state edges are
-- enforced by a trigger rather than by the service that calls it
-- (`RML-DEC-001`, doc 26 §2).
--
-- docs 05 (`STAY-DEC-002`, `STAY-DEC-004`, `STAY-DEC-005`, `STAY-DEC-006`),
-- 07 §§2–3, 18 §3, 26 (`RML-DEC-001`…`006`), 02 (`RC-DEC-040`);
-- ADR-0007 (money), ADR-0009 (append-only), ADR-0011 (revision/CAS),
-- ADR-0017 (RLS + roles), ADR-0018 (audit), ADR-0004 (versioned SQL).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- =====================================================================
-- Hotel-level stay configuration
-- =====================================================================

-- doc 05 §9 and §12, `STAY-DEC-004`, `STAY-DEC-007`: the hotel's fixed check-out
-- time, its cleaning minimum, and the default tariff of each stay type.
--
-- `config_version` is the version stamped onto every snapshot this hotel
-- captures. It is hotel-wide on purpose: an override at any level changes what
-- the next quote resolves to, so one monotonic number per hotel is what makes a
-- stored snapshot attributable to a configuration state. The trigger below
-- refuses a configuration edit that does not advance it.
CREATE TABLE platform.hotel_stay_configuration (
  hotel_id                uuid PRIMARY KEY,
  -- Nullable is "not configured". Zero is a price of nothing and is a different
  -- statement, which is why the refusal lives in the service and not in a
  -- COALESCE here.
  hourly_rate_mnt         bigint,
  nightly_rate_mnt        bigint,
  -- Minutes from hotel-local midnight. Integer minutes, never a float hour.
  fixed_checkout_minute   integer,
  cleaning_buffer_minutes integer,
  config_version          integer NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_stay_configuration_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_stay_configuration_hourly_non_negative
    CHECK (hourly_rate_mnt IS NULL OR hourly_rate_mnt >= 0),
  CONSTRAINT hotel_stay_configuration_nightly_non_negative
    CHECK (nightly_rate_mnt IS NULL OR nightly_rate_mnt >= 0),
  CONSTRAINT hotel_stay_configuration_checkout_minute_range
    CHECK (fixed_checkout_minute IS NULL OR fixed_checkout_minute BETWEEN 0 AND 1439),
  CONSTRAINT hotel_stay_configuration_buffer_range
    CHECK (cleaning_buffer_minutes IS NULL OR cleaning_buffer_minutes BETWEEN 0 AND 1440),
  CONSTRAINT hotel_stay_configuration_version_positive CHECK (config_version >= 1),
  CONSTRAINT hotel_stay_configuration_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- =====================================================================
-- Catalog entities
-- =====================================================================

-- doc 07 §2: the category carries the name, the optional hourly and nightly
-- overrides, and the optional cleaning-buffer override. There is no room-level
-- buffer: `STAY-DEC-004` configures the buffer at hotel and category level only.
CREATE TABLE platform.room_category (
  category_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  name                    text NOT NULL,
  description             text,
  state                   text NOT NULL DEFAULT 'ACTIVE',
  hourly_rate_mnt         bigint,
  nightly_rate_mnt        bigint,
  cleaning_buffer_minutes integer,
  -- The deactivation request that put the row in `RETIRING`, kept after the row
  -- reaches `INACTIVE` so the history of the transition survives it.
  retirement_requested_at timestamptz,
  retirement_reason       text,
  deactivated_at          timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT room_category_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  -- The target of the composite foreign keys below: a room, and a snapshot, may
  -- only reference a category of its own hotel, and the database is what says so.
  CONSTRAINT room_category_hotel_scope_uq UNIQUE (hotel_id, category_id),
  CONSTRAINT room_category_name_bounded CHECK (length(name) BETWEEN 1 AND 120),
  CONSTRAINT room_category_description_bounded
    CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  CONSTRAINT room_category_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text])),
  CONSTRAINT room_category_hourly_non_negative
    CHECK (hourly_rate_mnt IS NULL OR hourly_rate_mnt >= 0),
  CONSTRAINT room_category_nightly_non_negative
    CHECK (nightly_rate_mnt IS NULL OR nightly_rate_mnt >= 0),
  CONSTRAINT room_category_buffer_range
    CHECK (cleaning_buffer_minutes IS NULL OR cleaning_buffer_minutes BETWEEN 0 AND 1440),
  CONSTRAINT room_category_retiring_has_request
    CHECK (state <> 'RETIRING'::text OR retirement_requested_at IS NOT NULL),
  CONSTRAINT room_category_inactive_has_time
    CHECK (state <> 'INACTIVE'::text OR deactivated_at IS NOT NULL),
  CONSTRAINT room_category_active_is_clear
    CHECK (state <> 'ACTIVE'::text
           OR (retirement_requested_at IS NULL AND deactivated_at IS NULL)),
  CONSTRAINT room_category_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- doc 07 §3: a physical room. `room_number` is unique inside the hotel and
-- nowhere else — two hotels both having a `101` is ordinary.
--
-- The category reference is composite so a room cannot point at another
-- tenant's category even if a caller supplies its id: the pair has to exist in
-- `room_category`, and that table's own tenant column is part of the key.
CREATE TABLE platform.room (
  room_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  room_number             text NOT NULL,
  floor_label             text,
  category_id             uuid NOT NULL,
  state                   text NOT NULL DEFAULT 'ACTIVE',
  -- `STAY-DEC-005`: a room override applies to walk-in resolution only. Online
  -- quoting never reads these columns, because the physical room is not chosen
  -- until check-in.
  hourly_rate_mnt         bigint,
  nightly_rate_mnt        bigint,
  retirement_requested_at timestamptz,
  retirement_reason       text,
  deactivated_at          timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT room_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT room_category_fkey FOREIGN KEY (hotel_id, category_id)
    REFERENCES platform.room_category (hotel_id, category_id) ON DELETE RESTRICT,
  CONSTRAINT room_hotel_scope_uq UNIQUE (hotel_id, room_id),
  CONSTRAINT room_number_unique_per_hotel UNIQUE (hotel_id, room_number),
  CONSTRAINT room_number_bounded CHECK (length(room_number) BETWEEN 1 AND 20),
  CONSTRAINT room_floor_bounded
    CHECK (floor_label IS NULL OR length(floor_label) BETWEEN 1 AND 20),
  CONSTRAINT room_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text])),
  CONSTRAINT room_hourly_non_negative CHECK (hourly_rate_mnt IS NULL OR hourly_rate_mnt >= 0),
  CONSTRAINT room_nightly_non_negative CHECK (nightly_rate_mnt IS NULL OR nightly_rate_mnt >= 0),
  CONSTRAINT room_retiring_has_request
    CHECK (state <> 'RETIRING'::text OR retirement_requested_at IS NOT NULL),
  CONSTRAINT room_inactive_has_time
    CHECK (state <> 'INACTIVE'::text OR deactivated_at IS NOT NULL),
  CONSTRAINT room_active_is_clear
    CHECK (state <> 'ACTIVE'::text
           OR (retirement_requested_at IS NULL AND deactivated_at IS NULL)),
  CONSTRAINT room_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE INDEX room_category_idx ON platform.room (hotel_id, category_id);
--> statement-breakpoint

-- doc 26 §§6–7: the product and the template are minibar entities, and Phase 07
-- owns everything about them except the lifecycle they share with rooms and
-- categories. What is here is identity and lifecycle; selling price, purchase
-- cost, stock, template versions and their `DRAFT → PUBLISHED → ARCHIVED`
-- lifecycle are Phase 07's columns and Phase 07's tables, added to these rows
-- rather than to a second model of the same entity.
CREATE TABLE platform.minibar_product (
  product_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  name                    text NOT NULL,
  state                   text NOT NULL DEFAULT 'ACTIVE',
  retirement_requested_at timestamptz,
  retirement_reason       text,
  deactivated_at          timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT minibar_product_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_product_hotel_scope_uq UNIQUE (hotel_id, product_id),
  CONSTRAINT minibar_product_name_bounded CHECK (length(name) BETWEEN 1 AND 120),
  CONSTRAINT minibar_product_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text])),
  CONSTRAINT minibar_product_retiring_has_request
    CHECK (state <> 'RETIRING'::text OR retirement_requested_at IS NOT NULL),
  CONSTRAINT minibar_product_inactive_has_time
    CHECK (state <> 'INACTIVE'::text OR deactivated_at IS NOT NULL),
  CONSTRAINT minibar_product_active_is_clear
    CHECK (state <> 'ACTIVE'::text
           OR (retirement_requested_at IS NULL AND deactivated_at IS NULL)),
  CONSTRAINT minibar_product_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE TABLE platform.minibar_template (
  template_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  name                    text NOT NULL,
  state                   text NOT NULL DEFAULT 'ACTIVE',
  retirement_requested_at timestamptz,
  retirement_reason       text,
  deactivated_at          timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT minibar_template_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_template_hotel_scope_uq UNIQUE (hotel_id, template_id),
  CONSTRAINT minibar_template_name_bounded CHECK (length(name) BETWEEN 1 AND 120),
  CONSTRAINT minibar_template_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text])),
  CONSTRAINT minibar_template_retiring_has_request
    CHECK (state <> 'RETIRING'::text OR retirement_requested_at IS NOT NULL),
  CONSTRAINT minibar_template_inactive_has_time
    CHECK (state <> 'INACTIVE'::text OR deactivated_at IS NOT NULL),
  CONSTRAINT minibar_template_active_is_clear
    CHECK (state <> 'ACTIVE'::text
           OR (retirement_requested_at IS NULL AND deactivated_at IS NULL)),
  CONSTRAINT minibar_template_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- =====================================================================
-- History
-- =====================================================================

-- doc 26 §11 / `RML-DEC-006`: every transition carries actor, reason, time and
-- the blockers that were outstanding when it was made.
--
-- `entity_id` deliberately has **no** foreign key. `RML-DEC-005` permits a
-- never-used entity to be hard-deleted, and the record of that deletion has to
-- outlive the row it describes; a referential action would either delete the
-- history with it or refuse the deletion the decision allows.
CREATE TABLE platform.catalog_event (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  event_type       text NOT NULL,
  from_state       text,
  to_state         text,
  reason           text,
  config_version   integer,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_account_id uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT catalog_event_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT catalog_event_entity_type_known
    CHECK (entity_type = ANY (ARRAY['ROOM'::text, 'ROOM_CATEGORY'::text,
                                    'MINIBAR_PRODUCT'::text, 'MINIBAR_TEMPLATE'::text,
                                    'HOTEL_STAY_CONFIGURATION'::text])),
  CONSTRAINT catalog_event_type_known
    CHECK (event_type = ANY (ARRAY['CREATED'::text, 'UPDATED'::text,
                                   'TARIFF_SET'::text, 'TARIFF_CLEARED'::text,
                                   'CONFIGURATION_SET'::text,
                                   'RETIREMENT_REQUESTED'::text, 'RETIREMENT_CANCELLED'::text,
                                   'DEACTIVATED'::text, 'REACTIVATED'::text,
                                   'HARD_DELETED'::text])),
  CONSTRAINT catalog_event_state_known
    CHECK ((from_state IS NULL
            OR from_state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text]))
           AND (to_state IS NULL
            OR to_state = ANY (ARRAY['ACTIVE'::text, 'RETIRING'::text, 'INACTIVE'::text]))),
  CONSTRAINT catalog_event_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  CONSTRAINT catalog_event_version_positive
    CHECK (config_version IS NULL OR config_version >= 1),
  -- The same rule the audit stream carries: a permanent record may not become a
  -- place a secret or a full identifier is kept (CLAUDE.md §8).
  CONSTRAINT catalog_event_payload_has_no_denied_key
    CHECK (NOT platform.contains_denied_key(payload))
);
--> statement-breakpoint

CREATE INDEX catalog_event_entity_idx
  ON platform.catalog_event (hotel_id, entity_type, entity_id, occurred_at);
--> statement-breakpoint

-- doc 05 §13.2 / `STAY-DEC-005`: the confirmation snapshot. Immutable, and
-- carrying enough to re-prove the price: the unit rate, which level supplied it,
-- which entity at that level, and the configuration version in force.
--
-- `subject_ref` names the walk-in stay or the online booking the snapshot was
-- captured for. It is not a foreign key because those aggregates arrive in
-- Phases 08 and 13; the uniqueness of `(hotel_id, subject_type, subject_ref)` is
-- what makes the capture idempotent in the meantime.
CREATE TABLE platform.stay_rate_snapshot (
  snapshot_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  subject_type            text NOT NULL,
  subject_ref             uuid NOT NULL,
  stay_type               text NOT NULL,
  unit_price_mnt          bigint NOT NULL,
  source_level            text NOT NULL,
  source_entity_id        uuid NOT NULL,
  pricing_config_version  integer NOT NULL,
  category_id             uuid NOT NULL,
  room_id                 uuid,
  cleaning_buffer_minutes integer NOT NULL,
  fixed_checkout_minute   integer,
  captured_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_rate_snapshot_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  -- Historical references block a hard delete, and these two say so in the
  -- database rather than in a service check (`RML-DEC-005`).
  CONSTRAINT stay_rate_snapshot_category_fkey FOREIGN KEY (hotel_id, category_id)
    REFERENCES platform.room_category (hotel_id, category_id) ON DELETE RESTRICT,
  CONSTRAINT stay_rate_snapshot_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT stay_rate_snapshot_subject_uq UNIQUE (hotel_id, subject_type, subject_ref),
  CONSTRAINT stay_rate_snapshot_subject_known
    CHECK (subject_type = ANY (ARRAY['WALK_IN_STAY'::text, 'ONLINE_BOOKING'::text])),
  CONSTRAINT stay_rate_snapshot_stay_type_known
    CHECK (stay_type = ANY (ARRAY['HOURLY'::text, 'NIGHTLY'::text])),
  CONSTRAINT stay_rate_snapshot_source_level_known
    CHECK (source_level = ANY (ARRAY['ROOM'::text, 'CATEGORY'::text, 'HOTEL'::text])),
  CONSTRAINT stay_rate_snapshot_price_non_negative CHECK (unit_price_mnt >= 0),
  CONSTRAINT stay_rate_snapshot_version_positive CHECK (pricing_config_version >= 1),
  CONSTRAINT stay_rate_snapshot_buffer_range
    CHECK (cleaning_buffer_minutes BETWEEN 0 AND 1440),
  CONSTRAINT stay_rate_snapshot_checkout_minute_range
    CHECK (fixed_checkout_minute IS NULL OR fixed_checkout_minute BETWEEN 0 AND 1439),
  -- A nightly stay ends at the snapshotted fixed check-out time; an hourly stay
  -- has none (`STAY-DEC-007`, doc 05 §9).
  CONSTRAINT stay_rate_snapshot_nightly_has_checkout
    CHECK ((stay_type = 'NIGHTLY'::text) = (fixed_checkout_minute IS NOT NULL)),
  -- `STAY-DEC-005`, as a constraint rather than as a convention: an online
  -- booking is quoted before a physical room exists, so its price can never have
  -- come from a room override.
  CONSTRAINT stay_rate_snapshot_online_never_room_source
    CHECK (subject_type <> 'ONLINE_BOOKING'::text OR source_level <> 'ROOM'::text),
  CONSTRAINT stay_rate_snapshot_room_source_has_room
    CHECK (source_level <> 'ROOM'::text OR room_id IS NOT NULL),
  CONSTRAINT stay_rate_snapshot_source_matches_level
    CHECK ((source_level = 'ROOM'::text AND source_entity_id = room_id)
           OR (source_level = 'CATEGORY'::text AND source_entity_id = category_id)
           OR (source_level = 'HOTEL'::text AND source_entity_id = hotel_id))
);
--> statement-breakpoint

CREATE INDEX stay_rate_snapshot_room_idx ON platform.stay_rate_snapshot (hotel_id, room_id);
--> statement-breakpoint
CREATE INDEX stay_rate_snapshot_category_idx
  ON platform.stay_rate_snapshot (hotel_id, category_id);
--> statement-breakpoint

-- =====================================================================
-- Guards
-- =====================================================================

-- The lifecycle, enforced where a direct statement cannot talk its way past it.
--
-- `RETIRING` is refused on INSERT: doc 26 §2 says a creating actor chooses
-- `ACTIVE` or `INACTIVE`, and the pending state is only ever the server's
-- record of a deactivation request it accepted.
CREATE OR REPLACE FUNCTION platform.catalog_entity_insert_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.state = 'RETIRING' THEN
    RAISE EXCEPTION 'a catalog entity is created ACTIVE or INACTIVE, never RETIRING'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- The identity is immutable, the revision only moves forward, and the state may
-- only take an edge doc 26 §2 draws. The primary key column is passed as a
-- trigger argument so the four entity tables share one guard instead of four
-- copies that could drift apart.
CREATE OR REPLACE FUNCTION platform.catalog_entity_update_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_key text := TG_ARGV[0];
BEGIN
  IF to_jsonb(NEW) ->> v_key IS DISTINCT FROM to_jsonb(OLD) ->> v_key
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a catalog entity identity is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;

  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'ACTIVE'   AND NEW.state IN ('RETIRING', 'INACTIVE')) OR
      (OLD.state = 'RETIRING' AND NEW.state IN ('INACTIVE', 'ACTIVE'))  OR
      (OLD.state = 'INACTIVE' AND NEW.state = 'ACTIVE')
    ) THEN
      RAISE EXCEPTION 'illegal catalog lifecycle transition % -> %', OLD.state, NEW.state
        USING ERRCODE = '22023';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- A configuration edit has to advance the version, because a snapshot that
-- stored the old number would otherwise be attributable to two different
-- configurations (doc 05 §13.2).
CREATE OR REPLACE FUNCTION platform.hotel_stay_configuration_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a hotel stay configuration is not deleted' USING ERRCODE = '42501';
  END IF;

  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a hotel stay configuration identity is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;

  IF (NEW.hourly_rate_mnt         IS DISTINCT FROM OLD.hourly_rate_mnt
      OR NEW.nightly_rate_mnt     IS DISTINCT FROM OLD.nightly_rate_mnt
      OR NEW.fixed_checkout_minute IS DISTINCT FROM OLD.fixed_checkout_minute
      OR NEW.cleaning_buffer_minutes IS DISTINCT FROM OLD.cleaning_buffer_minutes)
     AND NEW.config_version <= OLD.config_version THEN
    RAISE EXCEPTION 'a configuration change must advance config_version (was %, offered %)',
      OLD.config_version, NEW.config_version USING ERRCODE = '22023';
  END IF;

  IF NEW.config_version < OLD.config_version THEN
    RAISE EXCEPTION 'config_version must not go backwards' USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER room_category_insert_guard
  BEFORE INSERT ON platform.room_category
  FOR EACH ROW EXECUTE FUNCTION platform.catalog_entity_insert_guard();
--> statement-breakpoint
CREATE TRIGGER room_category_update_guard
  BEFORE UPDATE ON platform.room_category
  FOR EACH ROW EXECUTE FUNCTION platform.catalog_entity_update_guard('category_id');
--> statement-breakpoint
CREATE TRIGGER room_insert_guard
  BEFORE INSERT ON platform.room
  FOR EACH ROW EXECUTE FUNCTION platform.catalog_entity_insert_guard();
--> statement-breakpoint
CREATE TRIGGER room_update_guard
  BEFORE UPDATE ON platform.room
  FOR EACH ROW EXECUTE FUNCTION platform.catalog_entity_update_guard('room_id');
--> statement-breakpoint
CREATE TRIGGER minibar_product_insert_guard
  BEFORE INSERT ON platform.minibar_product
  FOR EACH ROW EXECUTE FUNCTION platform.catalog_entity_insert_guard();
--> statement-breakpoint
CREATE TRIGGER minibar_product_update_guard
  BEFORE UPDATE ON platform.minibar_product
  FOR EACH ROW EXECUTE FUNCTION platform.catalog_entity_update_guard('product_id');
--> statement-breakpoint
CREATE TRIGGER minibar_template_insert_guard
  BEFORE INSERT ON platform.minibar_template
  FOR EACH ROW EXECUTE FUNCTION platform.catalog_entity_insert_guard();
--> statement-breakpoint
CREATE TRIGGER minibar_template_update_guard
  BEFORE UPDATE ON platform.minibar_template
  FOR EACH ROW EXECUTE FUNCTION platform.catalog_entity_update_guard('template_id');
--> statement-breakpoint
CREATE TRIGGER hotel_stay_configuration_no_delete
  BEFORE DELETE ON platform.hotel_stay_configuration
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_stay_configuration_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_stay_configuration_transition_guard
  BEFORE UPDATE ON platform.hotel_stay_configuration
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_stay_configuration_guard();
--> statement-breakpoint

-- Append-only history, and an append-only snapshot. A configuration edit cannot
-- reach a captured price even with a direct statement (`RML-DEC-004`).
CREATE TRIGGER catalog_event_append_only
  BEFORE UPDATE OR DELETE ON platform.catalog_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER catalog_event_no_truncate
  BEFORE TRUNCATE ON platform.catalog_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stay_rate_snapshot_append_only
  BEFORE UPDATE OR DELETE ON platform.stay_rate_snapshot
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stay_rate_snapshot_no_truncate
  BEFORE TRUNCATE ON platform.stay_rate_snapshot
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Row level security
-- =====================================================================

ALTER TABLE platform.hotel_stay_configuration ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_stay_configuration FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_category            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_category            FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room                     ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room                     FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_product          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_product          FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_template         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_template         FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.catalog_event            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.catalog_event            FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_rate_snapshot       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_rate_snapshot       FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON platform.hotel_stay_configuration
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.room_category
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.room
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_product
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_template
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.catalog_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.stay_rate_snapshot
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Ownership and grants
-- =====================================================================

ALTER TABLE platform.hotel_stay_configuration OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.room_category            OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.room                     OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.minibar_product          OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.minibar_template         OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.catalog_event            OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.stay_rate_snapshot       OWNER TO prsystem_migrate;
--> statement-breakpoint

REVOKE ALL ON platform.hotel_stay_configuration, platform.room_category, platform.room,
              platform.minibar_product, platform.minibar_template,
              platform.catalog_event, platform.stay_rate_snapshot
  FROM PUBLIC;
--> statement-breakpoint

-- The API owns these code paths. DELETE is granted on the four entity tables and
-- nowhere else: `RML-DEC-005` permits a never-used entity to be removed, and the
-- foreign keys above are what refuse it once anything references the row. No
-- role holds UPDATE or DELETE on either history table.
GRANT SELECT, INSERT, UPDATE ON platform.hotel_stay_configuration TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.room_category TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.room TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.minibar_product TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.minibar_template TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.catalog_event TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.stay_rate_snapshot TO prsystem_api;
--> statement-breakpoint

-- The worker reads the catalog to resolve what an outbox event refers to and
-- writes none of it.
GRANT SELECT ON platform.hotel_stay_configuration, platform.room_category, platform.room,
                platform.minibar_product, platform.minibar_template,
                platform.catalog_event, platform.stay_rate_snapshot
  TO prsystem_worker;
