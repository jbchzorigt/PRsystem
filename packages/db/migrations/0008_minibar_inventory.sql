-- Minibar inventory and templates: product pricing and cost, the two stock
-- locations and their immutable movement ledger, template versions, room
-- configuration with at most one pending change, reconciliation tasks, room
-- and multi-room Rollout, and the shortage override.
--
-- Four structural rules run through this migration.
--
-- **A balance is derived from the ledger, never written.** No runtime holds
-- INSERT or UPDATE on `minibar_warehouse_stock` or `room_minibar_stock`. The
-- only thing that changes a balance is a row appended to `inventory_movement`,
-- whose trigger — running as the table owner — applies the movement to the
-- locations it names and recomputes the weighted average cost. A balance below
-- zero is refused by a CHECK on the stock row, so a movement that would
-- over-draw a location fails as a movement (`INV-DEC-002`, `INV-DEC-003`,
-- `INV-DEC-005`, doc 22 §§2, 4, 11).
--
-- **A published version is a snapshot.** `minibar_template_version_item` may be
-- written only while its version is `DRAFT`; a trigger refuses every other
-- write. `PUBLISHED` content is what a room, a task and a check-in price book
-- refer to by exact id, and it never changes under them (`RML-DEC-016`).
--
-- **One current configuration, at most one pending change per room.** A partial
-- unique index holds the second half; the first is the primary key on the
-- configuration row (`RML-DEC-007`, doc 26 §14).
--
-- **Unset is not zero.** A product's selling price and purchase cost are
-- nullable and nullable means "not yet stated": an unpriced product cannot be
-- published into a version, and nothing here prices it at nothing. Average
-- cost is nullable until the first receipt establishes one (doc 22 §5).
--
-- docs 22 (`INV-DEC-001`…`008`), 26 §§14–38 (`RML-DEC-007`…`028`), 07 §§4–7,
-- 04 §5.3–5.4, 18 §§3–4, 02 (`RC-DEC-011`, `-018`, `-036`, `-041`, `-042`,
-- `-043`); ADR-0007 (money), ADR-0009 (append-only), ADR-0011 (revision/CAS),
-- ADR-0017 (RLS + roles), ADR-0018 (audit), ADR-0004 (versioned SQL).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- =====================================================================
-- Products and templates: the columns Phase 06 left to this phase
-- =====================================================================

-- doc 22 §3 / doc 07 §4. Selling price and purchase cost are separate and
-- separately nullable. `purchase_cost_mnt` is the cost the Manager states for
-- the next receipt; the cost the books carry is the weighted average on the
-- warehouse row, which only the ledger moves.
ALTER TABLE platform.minibar_product
  ADD COLUMN category          text,
  ADD COLUMN unit              text,
  ADD COLUMN selling_price_mnt bigint,
  ADD COLUMN purchase_cost_mnt bigint,
  ADD CONSTRAINT minibar_product_category_bounded
    CHECK (category IS NULL OR length(category) BETWEEN 1 AND 60),
  ADD CONSTRAINT minibar_product_unit_bounded
    CHECK (unit IS NULL OR length(unit) BETWEEN 1 AND 20),
  ADD CONSTRAINT minibar_product_selling_price_non_negative
    CHECK (selling_price_mnt IS NULL OR selling_price_mnt >= 0),
  ADD CONSTRAINT minibar_product_purchase_cost_non_negative
    CHECK (purchase_cost_mnt IS NULL OR purchase_cost_mnt >= 0);
--> statement-breakpoint

ALTER TABLE platform.minibar_template
  ADD COLUMN description text,
  ADD CONSTRAINT minibar_template_description_bounded
    CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500);
--> statement-breakpoint

-- =====================================================================
-- Stock locations
-- =====================================================================

-- doc 22 §2: the warehouse balance of a product, and the average cost the
-- ledger has established for it. One row per product, created by the first
-- movement. `avg_cost_mnt` is NULL until a receipt states a cost.
CREATE TABLE platform.minibar_warehouse_stock (
  product_id   uuid PRIMARY KEY,
  hotel_id     uuid NOT NULL,
  quantity     integer NOT NULL DEFAULT 0,
  avg_cost_mnt bigint,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT minibar_warehouse_stock_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_warehouse_stock_product_fkey FOREIGN KEY (hotel_id, product_id)
    REFERENCES platform.minibar_product (hotel_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_warehouse_stock_non_negative CHECK (quantity >= 0),
  CONSTRAINT minibar_warehouse_stock_cost_non_negative
    CHECK (avg_cost_mnt IS NULL OR avg_cost_mnt >= 0)
);
--> statement-breakpoint

-- doc 22 §2: what is physically in one room's minibar, per product.
CREATE TABLE platform.room_minibar_stock (
  room_id    uuid NOT NULL,
  product_id uuid NOT NULL,
  hotel_id   uuid NOT NULL,
  quantity   integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_minibar_stock_pkey PRIMARY KEY (room_id, product_id),
  CONSTRAINT room_minibar_stock_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT room_minibar_stock_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT room_minibar_stock_product_fkey FOREIGN KEY (hotel_id, product_id)
    REFERENCES platform.minibar_product (hotel_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT room_minibar_stock_non_negative CHECK (quantity >= 0)
);
--> statement-breakpoint

CREATE INDEX room_minibar_stock_product_idx ON platform.room_minibar_stock (hotel_id, product_id);
--> statement-breakpoint

-- =====================================================================
-- The movement ledger
-- =====================================================================

-- doc 22 §4: every change of stock is one immutable row. `unit_cost_mnt` is the
-- cost the movement carries — the stated cost of a receipt, the average cost in
-- force for everything else — so a consumption or a waste is costed at the
-- average of its own moment and never re-costed by a later purchase (§5).
--
-- `stay_id` is a reference Phase 08 will give a foreign key; `task_id` and
-- `configuration_change_id` are this phase's; `original_movement_id` links a
-- reversal or a rollback to what it compensates. None of them is repointed.
CREATE TABLE platform.inventory_movement (
  movement_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  product_id              uuid NOT NULL,
  movement_type           text NOT NULL,
  location                text NOT NULL,
  room_id                 uuid,
  quantity                integer NOT NULL,
  unit_cost_mnt           bigint,
  reason                  text,
  stay_id                 uuid,
  task_id                 uuid,
  configuration_change_id uuid,
  original_movement_id    uuid,
  actor_account_id        uuid,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inventory_movement_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movement_product_fkey FOREIGN KEY (hotel_id, product_id)
    REFERENCES platform.minibar_product (hotel_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movement_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movement_original_fkey FOREIGN KEY (original_movement_id)
    REFERENCES platform.inventory_movement (movement_id) ON DELETE RESTRICT,
  CONSTRAINT inventory_movement_type_known
    CHECK (movement_type = ANY (ARRAY['OPENING'::text, 'PURCHASE'::text,
                                      'TRANSFER_TO_ROOM'::text, 'RETURN_TO_WAREHOUSE'::text,
                                      'GUEST_CONSUMPTION'::text, 'WASTE'::text,
                                      'ADJUST_PLUS'::text, 'ADJUST_MINUS'::text])),
  CONSTRAINT inventory_movement_location_known
    CHECK (location = ANY (ARRAY['WAREHOUSE'::text, 'ROOM'::text, 'TRANSFER'::text])),
  CONSTRAINT inventory_movement_quantity_positive CHECK (quantity > 0),
  CONSTRAINT inventory_movement_cost_non_negative
    CHECK (unit_cost_mnt IS NULL OR unit_cost_mnt >= 0),
  CONSTRAINT inventory_movement_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  -- A transfer names both locations, so it names a room; a warehouse-only
  -- movement names none; a room movement names one.
  CONSTRAINT inventory_movement_location_shape CHECK (
    (movement_type IN ('TRANSFER_TO_ROOM', 'RETURN_TO_WAREHOUSE')
       AND location = 'TRANSFER' AND room_id IS NOT NULL)
    OR (movement_type IN ('OPENING', 'PURCHASE')
       AND location = 'WAREHOUSE' AND room_id IS NULL)
    OR (movement_type = 'GUEST_CONSUMPTION' AND location = 'ROOM' AND room_id IS NOT NULL)
    OR (movement_type IN ('WASTE', 'ADJUST_PLUS', 'ADJUST_MINUS')
       AND ((location = 'WAREHOUSE' AND room_id IS NULL)
            OR (location = 'ROOM' AND room_id IS NOT NULL)))
  ),
  -- A receipt states its cost; a positive adjustment states the cost it is
  -- taken in at (doc 22 §5). Waste and adjustment carry a reason.
  CONSTRAINT inventory_movement_receipt_has_cost
    CHECK (movement_type NOT IN ('OPENING', 'PURCHASE', 'ADJUST_PLUS') OR unit_cost_mnt IS NOT NULL),
  CONSTRAINT inventory_movement_correction_has_reason
    CHECK (movement_type NOT IN ('WASTE', 'ADJUST_PLUS', 'ADJUST_MINUS') OR reason IS NOT NULL)
);
--> statement-breakpoint

CREATE INDEX inventory_movement_product_idx
  ON platform.inventory_movement (hotel_id, product_id, occurred_at);
--> statement-breakpoint
CREATE INDEX inventory_movement_room_idx
  ON platform.inventory_movement (hotel_id, room_id, occurred_at);
--> statement-breakpoint
CREATE INDEX inventory_movement_change_idx
  ON platform.inventory_movement (hotel_id, configuration_change_id);
--> statement-breakpoint
CREATE INDEX inventory_movement_stay_idx ON platform.inventory_movement (hotel_id, stay_id);
--> statement-breakpoint

-- The one place a balance changes. Runs as the owner of the stock tables, on
-- which no runtime holds a write grant.
--
-- The warehouse row is created by the first movement. The average cost is
-- recomputed on the movements that bring stock in at a stated cost, over the
-- hotel's whole physical quantity — warehouse plus every room — because the
-- average is hotel-level (doc 22 §5): a transfer moves quantity between
-- locations and leaves the average alone. Integer arithmetic, rounded half
-- up, once.
CREATE OR REPLACE FUNCTION platform.inventory_movement_apply() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_total     bigint;
  v_avg       bigint;
  v_new_avg   bigint;
  v_divisor   bigint;
BEGIN
  INSERT INTO platform.minibar_warehouse_stock (product_id, hotel_id)
  VALUES (NEW.product_id, NEW.hotel_id)
  ON CONFLICT (product_id) DO NOTHING;

  IF NEW.movement_type IN ('OPENING', 'PURCHASE', 'ADJUST_PLUS') THEN
    SELECT w.quantity + coalesce((SELECT sum(r.quantity) FROM platform.room_minibar_stock r
                                   WHERE r.product_id = NEW.product_id), 0),
           w.avg_cost_mnt
      INTO v_total, v_avg
      FROM platform.minibar_warehouse_stock w
     WHERE w.product_id = NEW.product_id
       FOR UPDATE;
    IF v_total = 0 OR v_avg IS NULL THEN
      v_new_avg := NEW.unit_cost_mnt;
    ELSE
      v_divisor := v_total + NEW.quantity;
      v_new_avg := (v_total * v_avg + NEW.quantity * NEW.unit_cost_mnt + v_divisor / 2) / v_divisor;
    END IF;
    UPDATE platform.minibar_warehouse_stock
       SET avg_cost_mnt = v_new_avg, updated_at = now()
     WHERE product_id = NEW.product_id;
  END IF;

  IF NEW.movement_type IN ('OPENING', 'PURCHASE')
     OR (NEW.movement_type = 'ADJUST_PLUS' AND NEW.location = 'WAREHOUSE') THEN
    UPDATE platform.minibar_warehouse_stock
       SET quantity = quantity + NEW.quantity, updated_at = now()
     WHERE product_id = NEW.product_id;
  ELSIF NEW.movement_type = 'TRANSFER_TO_ROOM' THEN
    UPDATE platform.minibar_warehouse_stock
       SET quantity = quantity - NEW.quantity, updated_at = now()
     WHERE product_id = NEW.product_id;
    INSERT INTO platform.room_minibar_stock (room_id, product_id, hotel_id, quantity)
    VALUES (NEW.room_id, NEW.product_id, NEW.hotel_id, NEW.quantity)
    ON CONFLICT (room_id, product_id) DO UPDATE
      SET quantity = platform.room_minibar_stock.quantity + EXCLUDED.quantity, updated_at = now();
  ELSIF NEW.movement_type = 'RETURN_TO_WAREHOUSE' THEN
    UPDATE platform.room_minibar_stock
       SET quantity = quantity - NEW.quantity, updated_at = now()
     WHERE room_id = NEW.room_id AND product_id = NEW.product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no room stock to return' USING ERRCODE = '23514';
    END IF;
    UPDATE platform.minibar_warehouse_stock
       SET quantity = quantity + NEW.quantity, updated_at = now()
     WHERE product_id = NEW.product_id;
  ELSIF NEW.movement_type = 'ADJUST_PLUS' THEN
    INSERT INTO platform.room_minibar_stock (room_id, product_id, hotel_id, quantity)
    VALUES (NEW.room_id, NEW.product_id, NEW.hotel_id, NEW.quantity)
    ON CONFLICT (room_id, product_id) DO UPDATE
      SET quantity = platform.room_minibar_stock.quantity + EXCLUDED.quantity, updated_at = now();
  ELSIF NEW.location = 'WAREHOUSE' THEN
    UPDATE platform.minibar_warehouse_stock
       SET quantity = quantity - NEW.quantity, updated_at = now()
     WHERE product_id = NEW.product_id;
  ELSE
    UPDATE platform.room_minibar_stock
       SET quantity = quantity - NEW.quantity, updated_at = now()
     WHERE room_id = NEW.room_id AND product_id = NEW.product_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no room stock to draw from' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- A minus movement is costed at the average in force; the ledger records it
-- rather than trusting the caller to have looked it up (doc 22 §5).
CREATE OR REPLACE FUNCTION platform.inventory_movement_cost() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.movement_type NOT IN ('OPENING', 'PURCHASE', 'ADJUST_PLUS') THEN
    SELECT avg_cost_mnt INTO NEW.unit_cost_mnt
      FROM platform.minibar_warehouse_stock WHERE product_id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER inventory_movement_cost
  BEFORE INSERT ON platform.inventory_movement
  FOR EACH ROW EXECUTE FUNCTION platform.inventory_movement_cost();
--> statement-breakpoint
CREATE TRIGGER inventory_movement_apply
  AFTER INSERT ON platform.inventory_movement
  FOR EACH ROW EXECUTE FUNCTION platform.inventory_movement_apply();
--> statement-breakpoint
CREATE TRIGGER inventory_movement_append_only
  BEFORE UPDATE OR DELETE ON platform.inventory_movement
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER inventory_movement_no_truncate
  BEFORE TRUNCATE ON platform.inventory_movement
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Template versions
-- =====================================================================

-- doc 26 §24 / `RML-DEC-015`…`017`: the version lifecycle, separate from the
-- entity's. Exactly one Default per template while a Published version exists,
-- held by the partial unique index; a Default is always Published.
CREATE TABLE platform.minibar_template_version (
  version_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id               uuid NOT NULL,
  template_id            uuid NOT NULL,
  version_no             integer NOT NULL,
  state                  text NOT NULL DEFAULT 'DRAFT',
  is_default             boolean NOT NULL DEFAULT false,
  cloned_from_version_id uuid,
  published_at           timestamptz,
  archived_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  revision               integer NOT NULL DEFAULT 0,
  CONSTRAINT minibar_template_version_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_template_version_template_fkey FOREIGN KEY (hotel_id, template_id)
    REFERENCES platform.minibar_template (hotel_id, template_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_template_version_clone_fkey FOREIGN KEY (cloned_from_version_id)
    REFERENCES platform.minibar_template_version (version_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_template_version_hotel_scope_uq UNIQUE (hotel_id, version_id),
  CONSTRAINT minibar_template_version_binding_uq UNIQUE (hotel_id, template_id, version_id),
  CONSTRAINT minibar_template_version_number_uq UNIQUE (template_id, version_no),
  CONSTRAINT minibar_template_version_number_positive CHECK (version_no >= 1),
  CONSTRAINT minibar_template_version_state_known
    CHECK (state = ANY (ARRAY['DRAFT'::text, 'PUBLISHED'::text, 'ARCHIVED'::text])),
  CONSTRAINT minibar_template_version_default_is_published
    CHECK (NOT is_default OR state = 'PUBLISHED'::text),
  CONSTRAINT minibar_template_version_published_has_time
    CHECK ((state = 'DRAFT'::text) = (published_at IS NULL)),
  CONSTRAINT minibar_template_version_archived_has_time
    CHECK ((state = 'ARCHIVED'::text) = (archived_at IS NOT NULL)),
  CONSTRAINT minibar_template_version_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX minibar_template_version_default_uq
  ON platform.minibar_template_version (hotel_id, template_id) WHERE is_default IS TRUE;
--> statement-breakpoint

-- doc 26 §24.1: the product list and target quantity of one version. Written
-- only while the version is a draft; a published version's content is the
-- snapshot a room, a task and a price book refer to.
CREATE TABLE platform.minibar_template_version_item (
  item_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id        uuid NOT NULL,
  version_id      uuid NOT NULL,
  product_id      uuid NOT NULL,
  target_quantity integer NOT NULL,
  CONSTRAINT minibar_template_version_item_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_template_version_item_version_fkey FOREIGN KEY (hotel_id, version_id)
    REFERENCES platform.minibar_template_version (hotel_id, version_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_template_version_item_product_fkey FOREIGN KEY (hotel_id, product_id)
    REFERENCES platform.minibar_product (hotel_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_template_version_item_product_uq UNIQUE (version_id, product_id),
  CONSTRAINT minibar_template_version_item_target_positive CHECK (target_quantity >= 1)
);
--> statement-breakpoint

CREATE INDEX minibar_template_version_item_product_idx
  ON platform.minibar_template_version_item (hotel_id, product_id);
--> statement-breakpoint

-- The version edges (`RML-DEC-016`): DRAFT → PUBLISHED → ARCHIVED, nothing back.
CREATE OR REPLACE FUNCTION platform.minibar_template_version_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a template version identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state = 'DRAFT' AND NEW.state = 'PUBLISHED')
            OR (OLD.state = 'PUBLISHED' AND NEW.state = 'ARCHIVED')) THEN
      RAISE EXCEPTION 'illegal template version transition % -> %', OLD.state, NEW.state
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- Content is writable only under a draft. The parent is read here rather than
-- trusted from the caller.
CREATE OR REPLACE FUNCTION platform.minibar_template_version_item_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_version uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.version_id ELSE NEW.version_id END;
  v_state   text;
BEGIN
  SELECT state INTO v_state FROM platform.minibar_template_version WHERE version_id = v_version;
  IF v_state IS DISTINCT FROM 'DRAFT' THEN
    RAISE EXCEPTION 'a % template version is immutable', coalesce(v_state, 'missing')
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.item_id IS DISTINCT FROM OLD.item_id
                           OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
                           OR NEW.version_id IS DISTINCT FROM OLD.version_id) THEN
    RAISE EXCEPTION 'a template version item identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER minibar_template_version_update_guard
  BEFORE UPDATE ON platform.minibar_template_version
  FOR EACH ROW EXECUTE FUNCTION platform.minibar_template_version_guard();
--> statement-breakpoint
CREATE TRIGGER minibar_template_version_item_guard
  BEFORE INSERT OR UPDATE OR DELETE ON platform.minibar_template_version_item
  FOR EACH ROW EXECUTE FUNCTION platform.minibar_template_version_item_guard();
--> statement-breakpoint

-- =====================================================================
-- Room configuration, pending change, tasks
-- =====================================================================

-- doc 26 §14 / `RML-DEC-007`, `INV-DEC-007`: exactly one current configuration
-- per room. A room with no row is a room whose minibar is off. `ON` names the
-- template and the exact published version; the triple foreign key keeps the
-- version inside the template it names.
CREATE TABLE platform.room_minibar_configuration (
  room_id            uuid PRIMARY KEY,
  hotel_id           uuid NOT NULL,
  mode               text NOT NULL DEFAULT 'OFF',
  template_id        uuid,
  current_version_id uuid,
  minibar_status     text NOT NULL DEFAULT 'NOT_APPLICABLE',
  override_id        uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  revision           integer NOT NULL DEFAULT 0,
  CONSTRAINT room_minibar_configuration_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT room_minibar_configuration_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT room_minibar_configuration_template_fkey FOREIGN KEY (hotel_id, template_id)
    REFERENCES platform.minibar_template (hotel_id, template_id) ON DELETE RESTRICT,
  CONSTRAINT room_minibar_configuration_version_fkey
    FOREIGN KEY (hotel_id, template_id, current_version_id)
    REFERENCES platform.minibar_template_version (hotel_id, template_id, version_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_minibar_configuration_mode_known
    CHECK (mode = ANY (ARRAY['ON'::text, 'OFF'::text])),
  CONSTRAINT room_minibar_configuration_status_known
    CHECK (minibar_status = ANY (ARRAY['FULL'::text, 'SHORT'::text,
                                       'NOT_APPLICABLE'::text, 'UNKNOWN'::text])),
  CONSTRAINT room_minibar_configuration_mode_shape CHECK (
    (mode = 'ON' AND template_id IS NOT NULL AND current_version_id IS NOT NULL
       AND minibar_status <> 'NOT_APPLICABLE')
    OR (mode = 'OFF' AND template_id IS NULL AND current_version_id IS NULL
       AND minibar_status = 'NOT_APPLICABLE' AND override_id IS NULL)
  ),
  CONSTRAINT room_minibar_configuration_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE INDEX room_minibar_configuration_version_idx
  ON platform.room_minibar_configuration (hotel_id, current_version_id);
--> statement-breakpoint

-- doc 26 §§14–20, 33, 36 / `RML-DEC-007`…`014`, `-022`…`-028`: one pending
-- change per room, pinned to an exact target. The partial unique index is the
-- "at most one non-terminal" invariant.
CREATE TABLE platform.room_configuration_change (
  change_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id           uuid NOT NULL,
  room_id            uuid NOT NULL,
  kind               text NOT NULL,
  target_template_id uuid,
  target_version_id  uuid,
  state              text NOT NULL,
  batch_id           uuid,
  movement_started   boolean NOT NULL DEFAULT false,
  blocker_detail     jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason             text,
  requested_by       uuid,
  requested_at       timestamptz NOT NULL DEFAULT now(),
  terminal_at        timestamptz,
  revision           integer NOT NULL DEFAULT 0,
  CONSTRAINT room_configuration_change_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT room_configuration_change_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT room_configuration_change_target_fkey
    FOREIGN KEY (hotel_id, target_template_id, target_version_id)
    REFERENCES platform.minibar_template_version (hotel_id, template_id, version_id)
    ON DELETE RESTRICT,
  CONSTRAINT room_configuration_change_hotel_scope_uq UNIQUE (hotel_id, change_id),
  CONSTRAINT room_configuration_change_kind_known
    CHECK (kind = ANY (ARRAY['ON_TO_OFF'::text, 'OFF_TO_ON'::text,
                             'TEMPLATE_SWITCH'::text, 'VERSION_ROLLOUT'::text])),
  CONSTRAINT room_configuration_change_state_known
    CHECK (state = ANY (ARRAY['SCHEDULED_AFTER_STAY'::text, 'READY_FOR_RECONCILIATION'::text,
                              'IN_PROGRESS'::text, 'BLOCKED_STOCK'::text, 'BLOCKED_VARIANCE'::text,
                              'APPLIED'::text, 'CANCELLED'::text,
                              'ROLLBACK_REQUIRED'::text, 'ROLLED_BACK'::text])),
  CONSTRAINT room_configuration_change_target_shape CHECK (
    (kind = 'ON_TO_OFF' AND target_template_id IS NULL AND target_version_id IS NULL)
    OR (kind <> 'ON_TO_OFF' AND target_template_id IS NOT NULL AND target_version_id IS NOT NULL)
  ),
  CONSTRAINT room_configuration_change_terminal_has_time CHECK (
    (state = ANY (ARRAY['APPLIED'::text, 'CANCELLED'::text, 'ROLLED_BACK'::text]))
      = (terminal_at IS NOT NULL)
  ),
  CONSTRAINT room_configuration_change_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  CONSTRAINT room_configuration_change_detail_has_no_denied_key
    CHECK (NOT platform.contains_denied_key(blocker_detail)),
  CONSTRAINT room_configuration_change_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX room_configuration_change_one_pending_uq
  ON platform.room_configuration_change (hotel_id, room_id)
  WHERE state <> ALL (ARRAY['APPLIED'::text, 'CANCELLED'::text, 'ROLLED_BACK'::text]);
--> statement-breakpoint
CREATE INDEX room_configuration_change_target_idx
  ON platform.room_configuration_change (hotel_id, target_version_id);
--> statement-breakpoint
CREATE INDEX room_configuration_change_batch_idx
  ON platform.room_configuration_change (hotel_id, batch_id);
--> statement-breakpoint

-- The pending-change edges of doc 26 §14.1, enforced as data.
CREATE OR REPLACE FUNCTION platform.room_configuration_change_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.change_id IS DISTINCT FROM OLD.change_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.target_template_id IS DISTINCT FROM OLD.target_template_id
     OR NEW.target_version_id IS DISTINCT FROM OLD.target_version_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'a configuration change identity and its pinned target are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  IF OLD.movement_started AND NOT NEW.movement_started THEN
    RAISE EXCEPTION 'a posted movement cannot be unrecorded' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'SCHEDULED_AFTER_STAY' AND NEW.state IN ('READY_FOR_RECONCILIATION', 'CANCELLED'))
      OR (OLD.state = 'READY_FOR_RECONCILIATION'
          AND NEW.state IN ('IN_PROGRESS', 'BLOCKED_STOCK', 'BLOCKED_VARIANCE', 'APPLIED',
                            'CANCELLED', 'ROLLBACK_REQUIRED'))
      OR (OLD.state = 'IN_PROGRESS'
          AND NEW.state IN ('BLOCKED_STOCK', 'BLOCKED_VARIANCE', 'APPLIED', 'CANCELLED',
                            'ROLLBACK_REQUIRED'))
      OR (OLD.state IN ('BLOCKED_STOCK', 'BLOCKED_VARIANCE')
          AND NEW.state IN ('IN_PROGRESS', 'APPLIED', 'CANCELLED', 'ROLLBACK_REQUIRED'))
      OR (OLD.state = 'ROLLBACK_REQUIRED' AND NEW.state = 'ROLLED_BACK')
    ) THEN
      RAISE EXCEPTION 'illegal configuration change transition % -> %', OLD.state, NEW.state
        USING ERRCODE = '22023';
    END IF;
    -- A posted movement is never silently cancelled (`RML-DEC-014`).
    IF NEW.state = 'CANCELLED' AND OLD.movement_started THEN
      RAISE EXCEPTION 'a change with posted movements is rolled back, not cancelled'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER room_configuration_change_update_guard
  BEFORE UPDATE ON platform.room_configuration_change
  FOR EACH ROW EXECUTE FUNCTION platform.room_configuration_change_guard();
--> statement-breakpoint

-- doc 26 §§20–21, doc 04 §5.3 / `RML-DEC-013`: the server-bounded task a Cleaner
-- executes. `bounds` is the product/direction/maximum the server computed;
-- nothing the Cleaner sends can widen it. One open task per change.
CREATE TABLE platform.minibar_reconciliation_task (
  task_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id            uuid NOT NULL,
  change_id           uuid NOT NULL,
  room_id             uuid NOT NULL,
  kind                text NOT NULL,
  state               text NOT NULL DEFAULT 'OPEN',
  bounds              jsonb NOT NULL,
  counted             jsonb,
  assigned_account_id uuid,
  claimed_at          timestamptz,
  completed_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT minibar_reconciliation_task_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_reconciliation_task_change_fkey FOREIGN KEY (hotel_id, change_id)
    REFERENCES platform.room_configuration_change (hotel_id, change_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_reconciliation_task_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_reconciliation_task_kind_known
    CHECK (kind = ANY (ARRAY['RECONCILE'::text, 'ROLLBACK'::text])),
  CONSTRAINT minibar_reconciliation_task_state_known
    CHECK (state = ANY (ARRAY['OPEN'::text, 'CLAIMED'::text, 'COMPLETED'::text, 'CANCELLED'::text])),
  -- An open task has no assignee; a claimed or completed one has exactly the
  -- Cleaner who took it; a cancelled task may have had one or not.
  CONSTRAINT minibar_reconciliation_task_claim_shape CHECK (
    (state = 'OPEN'::text AND assigned_account_id IS NULL)
    OR (state = ANY (ARRAY['CLAIMED'::text, 'COMPLETED'::text]) AND assigned_account_id IS NOT NULL)
    OR state = 'CANCELLED'::text
  ),
  CONSTRAINT minibar_reconciliation_task_bounds_has_no_denied_key
    CHECK (NOT platform.contains_denied_key(bounds)),
  CONSTRAINT minibar_reconciliation_task_counted_has_no_denied_key
    CHECK (counted IS NULL OR NOT platform.contains_denied_key(counted)),
  CONSTRAINT minibar_reconciliation_task_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX minibar_reconciliation_task_one_open_uq
  ON platform.minibar_reconciliation_task (change_id)
  WHERE state = ANY (ARRAY['OPEN'::text, 'CLAIMED'::text]);
--> statement-breakpoint
CREATE INDEX minibar_reconciliation_task_assignee_idx
  ON platform.minibar_reconciliation_task (hotel_id, assigned_account_id, state);
--> statement-breakpoint

-- =====================================================================
-- Rollout batches
-- =====================================================================

-- doc 26 §36 / `RML-DEC-025`…`028`: the batch parent groups a selection and an
-- exact target; each accepted room's work is its own change row. State is
-- derived from the children on read and never stored.
CREATE TABLE platform.rollout_batch (
  batch_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id           uuid NOT NULL,
  template_id        uuid NOT NULL,
  target_version_id  uuid NOT NULL,
  retry_of_batch_id  uuid,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rollout_batch_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT rollout_batch_target_fkey FOREIGN KEY (hotel_id, template_id, target_version_id)
    REFERENCES platform.minibar_template_version (hotel_id, template_id, version_id)
    ON DELETE RESTRICT,
  CONSTRAINT rollout_batch_retry_fkey FOREIGN KEY (retry_of_batch_id)
    REFERENCES platform.rollout_batch (batch_id) ON DELETE RESTRICT,
  CONSTRAINT rollout_batch_hotel_scope_uq UNIQUE (hotel_id, batch_id)
);
--> statement-breakpoint

CREATE TABLE platform.rollout_batch_room (
  batch_id    uuid NOT NULL,
  room_id     uuid NOT NULL,
  hotel_id    uuid NOT NULL,
  result      text NOT NULL,
  reason_code text,
  change_id   uuid,
  CONSTRAINT rollout_batch_room_pkey PRIMARY KEY (batch_id, room_id),
  CONSTRAINT rollout_batch_room_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT rollout_batch_room_batch_fkey FOREIGN KEY (hotel_id, batch_id)
    REFERENCES platform.rollout_batch (hotel_id, batch_id) ON DELETE RESTRICT,
  CONSTRAINT rollout_batch_room_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT rollout_batch_room_change_fkey FOREIGN KEY (hotel_id, change_id)
    REFERENCES platform.room_configuration_change (hotel_id, change_id) ON DELETE RESTRICT,
  CONSTRAINT rollout_batch_room_result_known
    CHECK (result = ANY (ARRAY['ACCEPTED'::text, 'SKIPPED'::text])),
  CONSTRAINT rollout_batch_room_result_shape
    CHECK ((result = 'ACCEPTED'::text) = (change_id IS NOT NULL))
);
--> statement-breakpoint

-- =====================================================================
-- Shortage override
-- =====================================================================

-- doc 22 §8 / `INV-DEC-006`: the Manager's audited exception for the next stay
-- of a room whose minibar is short. Consumed by the check-in that uses it
-- (Phase 08 sets `consumed_at`).
CREATE TABLE platform.minibar_shortage_override (
  override_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL,
  room_id     uuid NOT NULL,
  snapshot    jsonb NOT NULL,
  reason      text NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz,
  CONSTRAINT minibar_shortage_override_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_shortage_override_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_shortage_override_hotel_scope_uq UNIQUE (hotel_id, override_id),
  CONSTRAINT minibar_shortage_override_reason_bounded CHECK (length(reason) BETWEEN 1 AND 300),
  CONSTRAINT minibar_shortage_override_snapshot_has_no_denied_key
    CHECK (NOT platform.contains_denied_key(snapshot))
);
--> statement-breakpoint

ALTER TABLE platform.room_minibar_configuration
  ADD CONSTRAINT room_minibar_configuration_override_fkey FOREIGN KEY (hotel_id, override_id)
    REFERENCES platform.minibar_shortage_override (hotel_id, override_id) ON DELETE RESTRICT;
--> statement-breakpoint

-- =====================================================================
-- History
-- =====================================================================

-- doc 22 §11, doc 26 §21: every version, configuration, task and batch
-- transition, with the exact ids it concerned. Append-only; no foreign key on
-- `entity_id`, for the same reason `catalog_event` has none.
CREATE TABLE platform.minibar_event (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  entity_type      text NOT NULL,
  entity_id        uuid NOT NULL,
  event_type       text NOT NULL,
  from_state       text,
  to_state         text,
  reason           text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_account_id uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT minibar_event_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_event_entity_type_known
    CHECK (entity_type = ANY (ARRAY['PRODUCT'::text, 'TEMPLATE_VERSION'::text,
                                    'ROOM_CONFIGURATION'::text, 'CONFIGURATION_CHANGE'::text,
                                    'RECONCILIATION_TASK'::text, 'ROLLOUT_BATCH'::text,
                                    'SHORTAGE_OVERRIDE'::text])),
  CONSTRAINT minibar_event_type_bounded CHECK (length(event_type) BETWEEN 1 AND 60),
  CONSTRAINT minibar_event_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  CONSTRAINT minibar_event_payload_has_no_denied_key
    CHECK (NOT platform.contains_denied_key(payload))
);
--> statement-breakpoint

CREATE INDEX minibar_event_entity_idx
  ON platform.minibar_event (hotel_id, entity_type, entity_id, occurred_at);
--> statement-breakpoint
CREATE TRIGGER minibar_event_append_only
  BEFORE UPDATE OR DELETE ON platform.minibar_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER minibar_event_no_truncate
  BEFORE TRUNCATE ON platform.minibar_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Row level security
-- =====================================================================

ALTER TABLE platform.minibar_warehouse_stock       ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_warehouse_stock       FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_minibar_stock            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_minibar_stock            FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.inventory_movement            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.inventory_movement            FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_template_version      ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_template_version      FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_template_version_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_template_version_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_minibar_configuration    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_minibar_configuration    FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_configuration_change     ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_configuration_change     FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_reconciliation_task   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_reconciliation_task   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.rollout_batch                 ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.rollout_batch                 FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.rollout_batch_room            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.rollout_batch_room            FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_shortage_override     ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_shortage_override     FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_event                 ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_event                 FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON platform.minibar_warehouse_stock
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.room_minibar_stock
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.inventory_movement
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_template_version
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_template_version_item
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.room_minibar_configuration
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.room_configuration_change
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_reconciliation_task
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.rollout_batch
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.rollout_batch_room
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_shortage_override
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Ownership and grants
-- =====================================================================

ALTER TABLE platform.minibar_warehouse_stock       OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.room_minibar_stock            OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.inventory_movement            OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.minibar_template_version      OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.minibar_template_version_item OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.room_minibar_configuration    OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.room_configuration_change     OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.minibar_reconciliation_task   OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.rollout_batch                 OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.rollout_batch_room            OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.minibar_shortage_override     OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.minibar_event                 OWNER TO prsystem_migrate;
--> statement-breakpoint
-- The two ledger triggers run as the same narrow, unreachable definer owner as
-- the D-09 wrappers and the provisioning wrapper (ownership manifest): nobody
-- can connect as it, and what it may write is exactly the two stock tables.
-- CREATE on the schema is needed only to take ownership and is revoked at the
-- end of this migration, exactly as `0003` and its remediations do.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint
ALTER FUNCTION platform.inventory_movement_apply() OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
ALTER FUNCTION platform.inventory_movement_cost() OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.inventory_movement_apply() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.inventory_movement_cost() FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.minibar_warehouse_stock, platform.room_minibar_stock
  TO prsystem_maintenance_fn;
--> statement-breakpoint

REVOKE ALL ON platform.minibar_warehouse_stock, platform.room_minibar_stock,
              platform.inventory_movement, platform.minibar_template_version,
              platform.minibar_template_version_item, platform.room_minibar_configuration,
              platform.room_configuration_change, platform.minibar_reconciliation_task,
              platform.rollout_batch, platform.rollout_batch_room,
              platform.minibar_shortage_override, platform.minibar_event
  FROM PUBLIC;
--> statement-breakpoint

-- Balances: read only, for everyone. The ledger: append only. Content of a
-- version: created and edited under a draft, deleted with a never-published
-- draft. A version, a configuration, a change and a task are updated by
-- transition; none of them is deleted. A batch and its rows are written once.
GRANT SELECT ON platform.minibar_warehouse_stock, platform.room_minibar_stock TO prsystem_api;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.inventory_movement_apply(), platform.inventory_movement_cost()
  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.inventory_movement TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.minibar_template_version TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.minibar_template_version_item TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.room_minibar_configuration TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.room_configuration_change TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.minibar_reconciliation_task TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.rollout_batch TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.rollout_batch_room TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.minibar_shortage_override TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.minibar_event TO prsystem_api;
--> statement-breakpoint

GRANT SELECT ON platform.minibar_warehouse_stock, platform.room_minibar_stock,
                platform.inventory_movement, platform.minibar_template_version,
                platform.minibar_template_version_item, platform.room_minibar_configuration,
                platform.room_configuration_change, platform.minibar_reconciliation_task,
                platform.rollout_batch, platform.rollout_batch_room,
                platform.minibar_shortage_override, platform.minibar_event
  TO prsystem_worker;
--> statement-breakpoint

-- ---------------------------------------------------- final privilege trim
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
