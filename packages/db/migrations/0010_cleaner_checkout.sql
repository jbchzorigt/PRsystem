-- Cleaner and checkout coordination: the cleaning work queue a Cleaner claims,
-- the minibar usage report a checkout cannot close without, its immutable
-- versions and priced lines, the guest's dispute, the lock a payment attempt
-- puts on the exact version it charges, the adjustments that are the only way
-- to correct a settled charge, and the active-stay refill task.
--
-- Five structural rules run through this migration.
--
-- **A report is a chain of immutable versions.** `minibar_usage_report_version`
-- and its lines are append-only; a correction is a new version, never an edit
-- of the one Reception disagreed with (`CHK-DEC-003`). The report row carries
-- only the pointer to the version that is current.
--
-- **The billable quantity is a formula the database enforces.** Each line
-- states the opening quantity of the price book, the refill confirmed during
-- the stay, the non-guest stock-out, the counted quantity, and the billable
-- quantity a CHECK holds to
-- `max(0, opening + refill − non_guest_out − counted)`; the line total is the
-- snapshot unit price times that quantity (doc 22 §8, `PRICE-DEC-005`).
--
-- **The unit price is the stay's, never the catalogue's.** Every line
-- references `platform.stay_minibar_price` by `(stay_id, product_id)`, so a
-- product absent from the check-in price book cannot be charged at all and a
-- later price edit cannot reach an active stay (`PRICE-DEC-002`, `-006`,
-- `-007`).
--
-- **A payment attempt locks one version, and one version can back one
-- successful charge.** `minibar_payment_lock` is unique per settled version and
-- per held report; a lock is released only for an attempt whose provider status
-- is a confirmed failure without funds, never for one still pending or unknown
-- (`CHK-DEC-004`).
--
-- **After a settlement, only adjustments.** `minibar_report_adjustment` is
-- append-only and references the original version and the settled lock; the
-- original report, its lines and its lock are never rewritten (`CHK-DEC-005`).
--
-- docs 04, 21 (`CHK-DEC-001`…`-006`), 25 (`PRICE-DEC-002`…`-008`), 22 §§6, 8,
-- 02 §§3.2–3.3, 18 §3; ADR-0007 (money), ADR-0009 (append-only), ADR-0011
-- (revision/CAS), ADR-0017 (RLS + roles), ADR-0018 (audit).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- =====================================================================
-- The cleaning work queue
-- =====================================================================

-- doc 04 §3 (3): the Cleaner's queue of rooms whose checkout is done and whose
-- cleaning is not. The cleaning state itself stays on `room_cleaning_state`
-- (Phase 08); this row is the assignable unit of work over it, and one
-- Cleaner claims it in one statement (doc 04 §8).
CREATE TABLE platform.cleaning_task (
  task_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id              uuid NOT NULL,
  room_id               uuid NOT NULL,
  stay_id               uuid,
  kind                  text NOT NULL DEFAULT 'CHECKOUT_CLEANING',
  state                 text NOT NULL DEFAULT 'PENDING',
  claimed_by_account_id uuid,
  claimed_at            timestamptz,
  completed_at          timestamptz,
  reason                text,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  revision              integer NOT NULL DEFAULT 0,
  CONSTRAINT cleaning_task_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT cleaning_task_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT cleaning_task_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT cleaning_task_kind_known CHECK (kind = 'CHECKOUT_CLEANING'::text),
  CONSTRAINT cleaning_task_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'IN_PROGRESS'::text,
                              'COMPLETED'::text, 'CANCELLED'::text])),
  CONSTRAINT cleaning_task_claim_shape
    CHECK ((state = 'PENDING'::text) = (claimed_by_account_id IS NULL)
           AND (claimed_by_account_id IS NULL) = (claimed_at IS NULL)),
  CONSTRAINT cleaning_task_completion_shape
    CHECK ((state = 'COMPLETED'::text) = (completed_at IS NOT NULL)),
  CONSTRAINT cleaning_task_cancel_shape
    CHECK ((state <> 'CANCELLED'::text) OR (reason IS NOT NULL)),
  CONSTRAINT cleaning_task_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  CONSTRAINT cleaning_task_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- One open cleaning task per room: two checkouts of the same room cannot leave
-- two claimable rows behind.
CREATE UNIQUE INDEX cleaning_task_one_open_uq
  ON platform.cleaning_task (hotel_id, room_id)
  WHERE state IN ('PENDING', 'IN_PROGRESS');
--> statement-breakpoint
CREATE INDEX cleaning_task_room_idx ON platform.cleaning_task (hotel_id, room_id, state);
--> statement-breakpoint
CREATE INDEX cleaning_task_stay_idx ON platform.cleaning_task (hotel_id, stay_id);
--> statement-breakpoint

-- The facts a task was opened on are immutable and its state moves forward
-- only; the claim is written once.
CREATE OR REPLACE FUNCTION platform.cleaning_task_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'a cleaning task and the checkout it was opened for are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.claimed_by_account_id IS NOT NULL
     AND NEW.claimed_by_account_id IS DISTINCT FROM OLD.claimed_by_account_id THEN
    RAISE EXCEPTION 'a claimed cleaning task keeps its Cleaner' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'PENDING' AND NEW.state IN ('IN_PROGRESS', 'CANCELLED'))
      OR (OLD.state = 'IN_PROGRESS' AND NEW.state IN ('COMPLETED', 'CANCELLED'))
    ) THEN
    RAISE EXCEPTION 'illegal cleaning task transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cleaning_task_update_guard
  BEFORE UPDATE ON platform.cleaning_task
  FOR EACH ROW EXECUTE FUNCTION platform.cleaning_task_guard();
--> statement-breakpoint
CREATE TRIGGER cleaning_task_no_delete
  BEFORE DELETE ON platform.cleaning_task
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The minibar usage report
-- =====================================================================

-- doc 21 §2, `CHK-DEC-001`: a minibar-enabled checkout opens this row when the
-- Reception starts the checkout, and the stay cannot complete until it is
-- settled or cancelled — the obligation Phase 08's checkout already probes.
--
-- The report carries no pointer to "the current version": the current one is
-- the highest `version_no` of its chain, because every submission creates the
-- next number and becomes the one in force (`CHK-DEC-003`). One source of
-- truth, and no cycle between the two tables.
CREATE TABLE platform.minibar_usage_report (
  report_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id              uuid NOT NULL,
  stay_id               uuid NOT NULL,
  room_id               uuid NOT NULL,
  state                 text NOT NULL DEFAULT 'PENDING',
  claimed_by_account_id uuid,
  claimed_at            timestamptz,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  settled_at            timestamptz,
  reason                text,
  revision              integer NOT NULL DEFAULT 0,
  CONSTRAINT minibar_usage_report_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_usage_report_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_usage_report_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_usage_report_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'IN_INSPECTION'::text, 'SUBMITTED'::text,
                              'RETURNED'::text, 'LOCKED'::text, 'SETTLED'::text,
                              'CANCELLED'::text])),
  CONSTRAINT minibar_usage_report_claim_shape
    CHECK ((claimed_by_account_id IS NULL) = (claimed_at IS NULL)),
  CONSTRAINT minibar_usage_report_settled_shape
    CHECK ((state = 'SETTLED'::text) = (settled_at IS NOT NULL)),
  CONSTRAINT minibar_usage_report_cancel_shape
    CHECK ((state <> 'CANCELLED'::text) OR (reason IS NOT NULL)),
  CONSTRAINT minibar_usage_report_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  CONSTRAINT minibar_usage_report_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- One live report per stay, and one per room while it is live.
CREATE UNIQUE INDEX minibar_usage_report_one_live_uq
  ON platform.minibar_usage_report (hotel_id, stay_id)
  WHERE state <> ALL (ARRAY['SETTLED'::text, 'CANCELLED'::text]);
--> statement-breakpoint
CREATE INDEX minibar_usage_report_room_idx
  ON platform.minibar_usage_report (hotel_id, room_id, state);
--> statement-breakpoint

-- doc 21 §8.2, `CHK-DEC-003`: every version is immutable and numbered; a
-- normal one is the Cleaner's, an exception one is a Manager's with a reason.
CREATE TABLE platform.minibar_usage_report_version (
  version_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  report_id               uuid NOT NULL,
  version_no              integer NOT NULL,
  kind                    text NOT NULL,
  no_usage                boolean NOT NULL DEFAULT false,
  reason                  text,
  submitted_by_account_id uuid NOT NULL,
  submitted_role          text NOT NULL,
  cutoff_at               timestamptz NOT NULL,
  total_mnt               bigint NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT minibar_usage_report_version_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_usage_report_version_report_fkey FOREIGN KEY (report_id)
    REFERENCES platform.minibar_usage_report (report_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_usage_report_version_no_uq UNIQUE (report_id, version_no),
  CONSTRAINT minibar_usage_report_version_no_positive CHECK (version_no >= 1),
  CONSTRAINT minibar_usage_report_version_kind_known
    CHECK (kind = ANY (ARRAY['NORMAL'::text, 'EXCEPTION'::text])),
  CONSTRAINT minibar_usage_report_version_role_known
    CHECK (submitted_role = ANY (ARRAY['CLEANER'::text, 'MANAGER'::text,
                                       'MANAGER_PLUS'::text])),
  -- `CHK-DEC-002`: the Cleaner submits the normal report; the exception one is
  -- a Manager's and states why it was needed.
  CONSTRAINT minibar_usage_report_version_normal_shape
    CHECK (kind <> 'NORMAL'::text OR submitted_role = 'CLEANER'::text),
  CONSTRAINT minibar_usage_report_version_exception_shape
    CHECK (kind <> 'EXCEPTION'::text
           OR (submitted_role IN ('MANAGER', 'MANAGER_PLUS') AND reason IS NOT NULL)),
  CONSTRAINT minibar_usage_report_version_no_usage_shape
    CHECK (NOT no_usage OR total_mnt = 0),
  CONSTRAINT minibar_usage_report_version_total_non_negative CHECK (total_mnt >= 0),
  CONSTRAINT minibar_usage_report_version_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE INDEX minibar_usage_report_version_report_idx
  ON platform.minibar_usage_report_version (hotel_id, report_id, version_no);
--> statement-breakpoint

-- doc 22 §8: the priced line. Its unit price is the stay's price book, and the
-- billable quantity is the documented formula, held by the database rather
-- than by the service that computes it.
CREATE TABLE platform.minibar_usage_report_line (
  line_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id               uuid NOT NULL,
  version_id             uuid NOT NULL,
  stay_id                uuid NOT NULL,
  product_id             uuid NOT NULL,
  product_name           text NOT NULL,
  opening_quantity       integer NOT NULL,
  refill_quantity        integer NOT NULL DEFAULT 0,
  non_guest_out_quantity integer NOT NULL DEFAULT 0,
  counted_quantity       integer NOT NULL,
  billable_quantity      integer NOT NULL,
  unit_price_mnt         bigint NOT NULL,
  line_total_mnt         bigint NOT NULL,
  CONSTRAINT minibar_usage_report_line_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_usage_report_line_version_fkey FOREIGN KEY (version_id)
    REFERENCES platform.minibar_usage_report_version (version_id) ON DELETE RESTRICT,
  -- `PRICE-DEC-006`: a product that was not in the check-in price book has no
  -- row to point at, so it cannot be charged.
  CONSTRAINT minibar_usage_report_line_price_book_fkey FOREIGN KEY (stay_id, product_id)
    REFERENCES platform.stay_minibar_price (stay_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_usage_report_line_product_uq UNIQUE (version_id, product_id),
  CONSTRAINT minibar_usage_report_line_quantities_non_negative
    CHECK (opening_quantity >= 0 AND refill_quantity >= 0
           AND non_guest_out_quantity >= 0 AND counted_quantity >= 0
           AND billable_quantity >= 0),
  CONSTRAINT minibar_usage_report_line_billable_formula
    CHECK (billable_quantity = GREATEST(0, opening_quantity + refill_quantity
                                           - non_guest_out_quantity - counted_quantity)),
  CONSTRAINT minibar_usage_report_line_total_formula
    CHECK (line_total_mnt = unit_price_mnt * billable_quantity),
  CONSTRAINT minibar_usage_report_line_price_non_negative CHECK (unit_price_mnt >= 0),
  CONSTRAINT minibar_usage_report_line_name_bounded
    CHECK (length(product_name) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE INDEX minibar_usage_report_line_version_idx
  ON platform.minibar_usage_report_line (hotel_id, version_id);
--> statement-breakpoint

-- doc 22 §8: the movements the version counted, so the arithmetic can be read
-- back from the ledger rather than trusted.
CREATE TABLE platform.minibar_usage_report_movement (
  version_id  uuid NOT NULL,
  movement_id uuid NOT NULL,
  hotel_id    uuid NOT NULL,
  role        text NOT NULL,
  CONSTRAINT minibar_usage_report_movement_pkey PRIMARY KEY (version_id, movement_id),
  CONSTRAINT minibar_usage_report_movement_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_usage_report_movement_version_fkey FOREIGN KEY (version_id)
    REFERENCES platform.minibar_usage_report_version (version_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_usage_report_movement_movement_fkey FOREIGN KEY (movement_id)
    REFERENCES platform.inventory_movement (movement_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_usage_report_movement_role_known
    CHECK (role = ANY (ARRAY['REFILL'::text, 'NON_GUEST_OUT'::text]))
);
--> statement-breakpoint

-- A version, its lines and the movements it counted are written once.
CREATE TRIGGER minibar_usage_report_version_append_only
  BEFORE UPDATE OR DELETE ON platform.minibar_usage_report_version
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER minibar_usage_report_version_no_truncate
  BEFORE TRUNCATE ON platform.minibar_usage_report_version
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER minibar_usage_report_line_append_only
  BEFORE UPDATE OR DELETE ON platform.minibar_usage_report_line
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER minibar_usage_report_line_no_truncate
  BEFORE TRUNCATE ON platform.minibar_usage_report_line
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER minibar_usage_report_movement_append_only
  BEFORE UPDATE OR DELETE ON platform.minibar_usage_report_movement
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER minibar_usage_report_movement_no_truncate
  BEFORE TRUNCATE ON platform.minibar_usage_report_movement
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- The report's own facts are immutable and its state moves forward, except the
-- one backward edge the requirement names: a locked report returns to
-- correction when an attempt is proven to have taken no money (`CHK-DEC-004`).
CREATE OR REPLACE FUNCTION platform.minibar_usage_report_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'a minibar usage report and the stay it belongs to are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'SETTLED' OR OLD.state = 'CANCELLED' THEN
    RAISE EXCEPTION 'a terminal minibar usage report is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      -- A Manager's exception version arrives without a Cleaner ever claiming
      -- the inspection (`CHK-DEC-002`), so `PENDING` submits directly.
      (OLD.state = 'PENDING' AND NEW.state IN ('IN_INSPECTION', 'SUBMITTED', 'CANCELLED'))
      OR (OLD.state = 'IN_INSPECTION' AND NEW.state IN ('SUBMITTED', 'CANCELLED'))
      OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('RETURNED', 'LOCKED', 'CANCELLED'))
      OR (OLD.state = 'RETURNED' AND NEW.state IN ('SUBMITTED', 'CANCELLED'))
      OR (OLD.state = 'LOCKED' AND NEW.state IN ('SETTLED', 'SUBMITTED', 'CANCELLED'))
    ) THEN
    RAISE EXCEPTION 'illegal minibar usage report transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER minibar_usage_report_update_guard
  BEFORE UPDATE ON platform.minibar_usage_report
  FOR EACH ROW EXECUTE FUNCTION platform.minibar_usage_report_guard();
--> statement-breakpoint
CREATE TRIGGER minibar_usage_report_no_delete
  BEFORE DELETE ON platform.minibar_usage_report
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The guest's dispute
-- =====================================================================

-- doc 21 §7, `CHK-DEC-006`: Reception marks the line, a Manager decides, and
-- the final settlement waits for that decision. A waiver never edits the
-- report; it records the amount it takes off.
CREATE TABLE platform.minibar_report_dispute (
  dispute_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  report_id               uuid NOT NULL,
  version_id              uuid NOT NULL,
  product_id              uuid NOT NULL,
  disputed_quantity       integer NOT NULL,
  state                   text NOT NULL DEFAULT 'OPEN',
  note                    text NOT NULL,
  noted_by_account_id     uuid NOT NULL,
  noted_at                timestamptz NOT NULL DEFAULT now(),
  resolved_by_account_id  uuid,
  resolved_at             timestamptz,
  resolution_reason       text,
  waived_amount_mnt       bigint,
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT minibar_report_dispute_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_report_dispute_report_fkey FOREIGN KEY (report_id)
    REFERENCES platform.minibar_usage_report (report_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_report_dispute_version_fkey FOREIGN KEY (version_id)
    REFERENCES platform.minibar_usage_report_version (version_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_report_dispute_product_fkey FOREIGN KEY (hotel_id, product_id)
    REFERENCES platform.minibar_product (hotel_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_report_dispute_state_known
    CHECK (state = ANY (ARRAY['OPEN'::text, 'UPHELD'::text, 'WAIVED'::text])),
  CONSTRAINT minibar_report_dispute_quantity_positive CHECK (disputed_quantity > 0),
  CONSTRAINT minibar_report_dispute_resolution_shape
    CHECK ((state = 'OPEN'::text) = (resolved_at IS NULL)
           AND (resolved_at IS NULL) = (resolved_by_account_id IS NULL)
           AND (resolved_at IS NULL) = (resolution_reason IS NULL)),
  CONSTRAINT minibar_report_dispute_waiver_shape
    CHECK ((state = 'WAIVED'::text) = (waived_amount_mnt IS NOT NULL)),
  CONSTRAINT minibar_report_dispute_waiver_non_negative
    CHECK (waived_amount_mnt IS NULL OR waived_amount_mnt >= 0),
  CONSTRAINT minibar_report_dispute_note_bounded CHECK (length(note) BETWEEN 1 AND 300),
  CONSTRAINT minibar_report_dispute_reason_bounded
    CHECK (resolution_reason IS NULL OR length(resolution_reason) BETWEEN 1 AND 300),
  CONSTRAINT minibar_report_dispute_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX minibar_report_dispute_report_idx
  ON platform.minibar_report_dispute (hotel_id, report_id, state);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.minibar_report_dispute_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.report_id IS DISTINCT FROM OLD.report_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.disputed_quantity IS DISTINCT FROM OLD.disputed_quantity
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.noted_by_account_id IS DISTINCT FROM OLD.noted_by_account_id
     OR NEW.noted_at IS DISTINCT FROM OLD.noted_at THEN
    RAISE EXCEPTION 'a dispute and the line it was raised on are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'OPEN' THEN
    RAISE EXCEPTION 'a decided dispute is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state NOT IN ('UPHELD', 'WAIVED') THEN
    RAISE EXCEPTION 'illegal dispute transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER minibar_report_dispute_update_guard
  BEFORE UPDATE ON platform.minibar_report_dispute
  FOR EACH ROW EXECUTE FUNCTION platform.minibar_report_dispute_guard();
--> statement-breakpoint
CREATE TRIGGER minibar_report_dispute_no_delete
  BEFORE DELETE ON platform.minibar_report_dispute
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The payment lock and the adjustments that follow a settlement
-- =====================================================================

-- doc 21 §5, `CHK-DEC-004`: the attempt names the exact version it charges and
-- holds it. A pending or unknown provider status keeps the hold; only a
-- confirmed failure without funds releases it.
CREATE TABLE platform.minibar_payment_lock (
  lock_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id               uuid NOT NULL,
  report_id              uuid NOT NULL,
  version_id             uuid NOT NULL,
  attempt_ref            text NOT NULL,
  state                  text NOT NULL DEFAULT 'HELD',
  provider_status        text,
  amount_mnt             bigint NOT NULL,
  locked_at              timestamptz NOT NULL DEFAULT now(),
  locked_by_account_id   uuid NOT NULL,
  resolved_at            timestamptz,
  resolved_by_account_id uuid,
  revision               integer NOT NULL DEFAULT 0,
  CONSTRAINT minibar_payment_lock_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_payment_lock_report_fkey FOREIGN KEY (report_id)
    REFERENCES platform.minibar_usage_report (report_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_payment_lock_version_fkey FOREIGN KEY (version_id)
    REFERENCES platform.minibar_usage_report_version (version_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_payment_lock_attempt_uq UNIQUE (hotel_id, attempt_ref),
  CONSTRAINT minibar_payment_lock_state_known
    CHECK (state = ANY (ARRAY['HELD'::text, 'RELEASED'::text, 'SETTLED'::text])),
  CONSTRAINT minibar_payment_lock_provider_status_known
    CHECK (provider_status IS NULL
           OR provider_status = ANY (ARRAY['PENDING'::text, 'UNKNOWN'::text,
                                           'FAILED_NO_FUNDS'::text, 'SUCCEEDED'::text])),
  CONSTRAINT minibar_payment_lock_resolution_shape
    CHECK ((state = 'HELD'::text) = (resolved_at IS NULL)
           AND (resolved_at IS NULL) = (resolved_by_account_id IS NULL)),
  -- A release states that no money moved; a settlement states that it did.
  CONSTRAINT minibar_payment_lock_release_shape
    CHECK (state <> 'RELEASED'::text OR provider_status = 'FAILED_NO_FUNDS'::text),
  CONSTRAINT minibar_payment_lock_settle_shape
    CHECK (state <> 'SETTLED'::text OR provider_status = 'SUCCEEDED'::text),
  CONSTRAINT minibar_payment_lock_amount_non_negative CHECK (amount_mnt >= 0),
  CONSTRAINT minibar_payment_lock_attempt_bounded
    CHECK (length(attempt_ref) BETWEEN 1 AND 120),
  CONSTRAINT minibar_payment_lock_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- One version can back one successful charge, and one report can hold one
-- attempt at a time.
CREATE UNIQUE INDEX minibar_payment_lock_one_settled_uq
  ON platform.minibar_payment_lock (version_id)
  WHERE state = 'SETTLED';
--> statement-breakpoint
CREATE UNIQUE INDEX minibar_payment_lock_one_held_uq
  ON platform.minibar_payment_lock (report_id)
  WHERE state = 'HELD';
--> statement-breakpoint
CREATE INDEX minibar_payment_lock_report_idx
  ON platform.minibar_payment_lock (hotel_id, report_id, state);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.minibar_payment_lock_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.report_id IS DISTINCT FROM OLD.report_id
     OR NEW.version_id IS DISTINCT FROM OLD.version_id
     OR NEW.attempt_ref IS DISTINCT FROM OLD.attempt_ref
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.locked_at IS DISTINCT FROM OLD.locked_at
     OR NEW.locked_by_account_id IS DISTINCT FROM OLD.locked_by_account_id THEN
    RAISE EXCEPTION 'a payment attempt and the version it charges are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'HELD' THEN
    RAISE EXCEPTION 'a resolved payment attempt is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state NOT IN ('HELD', 'RELEASED', 'SETTLED') THEN
    RAISE EXCEPTION 'illegal payment lock transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER minibar_payment_lock_update_guard
  BEFORE UPDATE ON platform.minibar_payment_lock
  FOR EACH ROW EXECUTE FUNCTION platform.minibar_payment_lock_guard();
--> statement-breakpoint
CREATE TRIGGER minibar_payment_lock_no_delete
  BEFORE DELETE ON platform.minibar_payment_lock
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 21 §6, `CHK-DEC-005`: after a settlement the report and the payment are
-- history. An overcharge is reversed, an undercharge becomes a new receivable,
-- and a waiver decided after the fact is its own row — each priced from the
-- original snapshot (`PRICE-DEC-004`).
CREATE TABLE platform.minibar_report_adjustment (
  adjustment_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id            uuid NOT NULL,
  report_id           uuid NOT NULL,
  original_version_id uuid NOT NULL,
  lock_id             uuid NOT NULL,
  kind                text NOT NULL,
  product_id          uuid,
  quantity            integer,
  unit_price_mnt      bigint,
  amount_mnt          bigint NOT NULL,
  reason              text NOT NULL,
  actor_account_id    uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT minibar_report_adjustment_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_report_adjustment_report_fkey FOREIGN KEY (report_id)
    REFERENCES platform.minibar_usage_report (report_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_report_adjustment_version_fkey FOREIGN KEY (original_version_id)
    REFERENCES platform.minibar_usage_report_version (version_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_report_adjustment_lock_fkey FOREIGN KEY (lock_id)
    REFERENCES platform.minibar_payment_lock (lock_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_report_adjustment_kind_known
    CHECK (kind = ANY (ARRAY['OVERCHARGE_REVERSAL'::text, 'UNDERCHARGE_RECEIVABLE'::text,
                             'DISPUTE_WAIVER'::text])),
  CONSTRAINT minibar_report_adjustment_line_shape
    CHECK ((product_id IS NULL) = (quantity IS NULL)
           AND (product_id IS NULL) = (unit_price_mnt IS NULL)),
  CONSTRAINT minibar_report_adjustment_quantity_positive
    CHECK (quantity IS NULL OR quantity > 0),
  CONSTRAINT minibar_report_adjustment_line_total
    CHECK (product_id IS NULL OR amount_mnt = unit_price_mnt * quantity),
  CONSTRAINT minibar_report_adjustment_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT minibar_report_adjustment_reason_bounded
    CHECK (length(reason) BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE INDEX minibar_report_adjustment_report_idx
  ON platform.minibar_report_adjustment (hotel_id, report_id, created_at);
--> statement-breakpoint
CREATE TRIGGER minibar_report_adjustment_append_only
  BEFORE UPDATE OR DELETE ON platform.minibar_report_adjustment
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER minibar_report_adjustment_no_truncate
  BEFORE TRUNCATE ON platform.minibar_report_adjustment
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The active-stay refill task
-- =====================================================================

-- doc 04 §5.1, doc 25 §6.1: Reception or a Manager asks; the request is not a
-- movement. A Cleaner claims the task and confirms what was actually put in
-- the room, and that confirmation is the one transfer.
CREATE TABLE platform.minibar_refill_task (
  task_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  room_id                 uuid NOT NULL,
  stay_id                 uuid NOT NULL,
  product_id              uuid NOT NULL,
  requested_quantity      integer NOT NULL,
  confirmed_quantity      integer,
  state                   text NOT NULL DEFAULT 'PENDING',
  requested_by_account_id uuid NOT NULL,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  cleaner_account_id      uuid,
  claimed_at              timestamptz,
  completed_at            timestamptz,
  reason                  text,
  movement_id             uuid,
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT minibar_refill_task_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_refill_task_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_refill_task_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  -- `PRICE-DEC-005`: a refill is against a line of the stay's price book, so a
  -- product the stay was never priced for cannot be added to it.
  CONSTRAINT minibar_refill_task_price_book_fkey FOREIGN KEY (stay_id, product_id)
    REFERENCES platform.stay_minibar_price (stay_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_refill_task_movement_fkey FOREIGN KEY (movement_id)
    REFERENCES platform.inventory_movement (movement_id) ON DELETE RESTRICT,
  CONSTRAINT minibar_refill_task_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'IN_PROGRESS'::text, 'COMPLETED'::text,
                              'CANCELLED'::text, 'IMPOSSIBLE'::text])),
  CONSTRAINT minibar_refill_task_requested_positive CHECK (requested_quantity > 0),
  CONSTRAINT minibar_refill_task_confirmed_bounded
    CHECK (confirmed_quantity IS NULL
           OR (confirmed_quantity > 0 AND confirmed_quantity <= requested_quantity)),
  CONSTRAINT minibar_refill_task_claim_shape
    CHECK ((cleaner_account_id IS NULL) = (claimed_at IS NULL)),
  CONSTRAINT minibar_refill_task_completion_shape
    CHECK ((state = 'COMPLETED'::text)
           = (confirmed_quantity IS NOT NULL AND movement_id IS NOT NULL
              AND completed_at IS NOT NULL)),
  CONSTRAINT minibar_refill_task_terminal_reason
    CHECK (state NOT IN ('CANCELLED', 'IMPOSSIBLE') OR reason IS NOT NULL),
  CONSTRAINT minibar_refill_task_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  CONSTRAINT minibar_refill_task_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX minibar_refill_task_one_open_uq
  ON platform.minibar_refill_task (hotel_id, room_id, product_id)
  WHERE state IN ('PENDING', 'IN_PROGRESS');
--> statement-breakpoint
CREATE INDEX minibar_refill_task_room_idx
  ON platform.minibar_refill_task (hotel_id, room_id, state);
--> statement-breakpoint
CREATE INDEX minibar_refill_task_product_idx
  ON platform.minibar_refill_task (hotel_id, product_id, state);
--> statement-breakpoint
CREATE INDEX minibar_refill_task_stay_idx ON platform.minibar_refill_task (hotel_id, stay_id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.minibar_refill_task_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.product_id IS DISTINCT FROM OLD.product_id
     OR NEW.requested_quantity IS DISTINCT FROM OLD.requested_quantity
     OR NEW.requested_by_account_id IS DISTINCT FROM OLD.requested_by_account_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'a refill request and what it asked for are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state IN ('COMPLETED', 'CANCELLED', 'IMPOSSIBLE') THEN
    RAISE EXCEPTION 'a terminal refill task is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.cleaner_account_id IS NOT NULL
     AND NEW.cleaner_account_id IS DISTINCT FROM OLD.cleaner_account_id THEN
    RAISE EXCEPTION 'a claimed refill task keeps its Cleaner' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'PENDING' AND NEW.state IN ('IN_PROGRESS', 'CANCELLED'))
      OR (OLD.state = 'IN_PROGRESS'
          AND NEW.state IN ('COMPLETED', 'CANCELLED', 'IMPOSSIBLE'))
    ) THEN
    RAISE EXCEPTION 'illegal refill task transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER minibar_refill_task_update_guard
  BEFORE UPDATE ON platform.minibar_refill_task
  FOR EACH ROW EXECUTE FUNCTION platform.minibar_refill_task_guard();
--> statement-breakpoint
CREATE TRIGGER minibar_refill_task_no_delete
  BEFORE DELETE ON platform.minibar_refill_task
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The checkout a Reception can call off
-- =====================================================================

-- doc 04 §8: cancelling a started checkout returns the stay to the guests who
-- are still in the room, and leaves the report and the tasks it created behind
-- as cancelled history rather than deleting them. Phase 08 wrote this guard
-- with a forward-only edge because nothing could yet call a checkout off; the
-- one backward edge is added here, and every other rule of the guard —
-- write-once times, an increasing revision, an actual checkout recorded only
-- with the transition that completes the stay, a completed stay immutable — is
-- unchanged.
CREATE OR REPLACE FUNCTION platform.stay_update_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.booking_ref IS DISTINCT FROM OLD.booking_ref
     OR NEW.stay_type IS DISTINCT FROM OLD.stay_type
     OR NEW.actual_check_in_at IS DISTINCT FROM OLD.actual_check_in_at
     OR NEW.check_in_recorded_at IS DISTINCT FROM OLD.check_in_recorded_at
     OR NEW.planned_checkout_at IS DISTINCT FROM OLD.planned_checkout_at
     OR NEW.half_hour_units IS DISTINCT FROM OLD.half_hour_units
     OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
     OR NEW.night_count IS DISTINCT FROM OLD.night_count
     OR NEW.fixed_checkout_minute IS DISTINCT FROM OLD.fixed_checkout_minute
     OR NEW.cleaning_buffer_minutes IS DISTINCT FROM OLD.cleaning_buffer_minutes
     OR NEW.rate_snapshot_id IS DISTINCT FROM OLD.rate_snapshot_id
     OR NEW.unit_rate_mnt IS DISTINCT FROM OLD.unit_rate_mnt
     OR NEW.room_charge_mnt IS DISTINCT FROM OLD.room_charge_mnt
     OR NEW.pricing_config_version IS DISTINCT FROM OLD.pricing_config_version
     OR NEW.deposit_required IS DISTINCT FROM OLD.deposit_required
     OR NEW.shift_id IS DISTINCT FROM OLD.shift_id
     OR NEW.checked_in_by_account_id IS DISTINCT FROM OLD.checked_in_by_account_id
     OR NEW.backdate_minutes IS DISTINCT FROM OLD.backdate_minutes
     OR NEW.backdate_reason_code IS DISTINCT FROM OLD.backdate_reason_code
     OR NEW.backdate_note IS DISTINCT FROM OLD.backdate_note
     OR NEW.minibar_applicable IS DISTINCT FROM OLD.minibar_applicable
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the times, snapshot and identity of a stay are written once (STAY-DEC-009, STAY-DEC-011, STAY-DEC-012)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT (
      (OLD.state = 'ACTIVE' AND NEW.state IN ('CHECKOUT_IN_PROGRESS', 'COMPLETED'))
      OR (OLD.state = 'CHECKOUT_IN_PROGRESS' AND NEW.state IN ('COMPLETED', 'ACTIVE'))
    ) THEN
      RAISE EXCEPTION 'illegal stay transition % -> %', OLD.state, NEW.state USING ERRCODE = '22023';
    END IF;
  ELSIF NEW.actual_checkout_at IS DISTINCT FROM OLD.actual_checkout_at THEN
    RAISE EXCEPTION 'an actual checkout is recorded with the transition that completes the stay'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'COMPLETED' THEN
    RAISE EXCEPTION 'a completed stay is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- =====================================================================
-- Row Level Security
-- =====================================================================

ALTER TABLE platform.cleaning_task                    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.cleaning_task                    FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_usage_report             ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_usage_report             FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_usage_report_version     ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_usage_report_version     FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_usage_report_line        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_usage_report_line        FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_usage_report_movement    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_usage_report_movement    FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_report_dispute           ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_report_dispute           FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_payment_lock             ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_payment_lock             FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_report_adjustment        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_report_adjustment        FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_refill_task              ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.minibar_refill_task              FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON platform.cleaning_task
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_usage_report
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_usage_report_version
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_usage_report_line
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_usage_report_movement
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_report_dispute
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_payment_lock
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_report_adjustment
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.minibar_refill_task
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Grants
-- =====================================================================

-- The API writes what a Reception, a Manager or a Cleaner does. Nothing it
-- holds lets it rewrite a submitted version, a priced line, a settled lock or
-- an adjustment: those are append-only to the database, not by convention.
-- The worker reads what a projection and a report need.
GRANT SELECT, INSERT, UPDATE ON platform.cleaning_task                 TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.minibar_usage_report          TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.minibar_usage_report_version  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.minibar_usage_report_line     TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.minibar_usage_report_movement TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.minibar_report_dispute        TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.minibar_payment_lock          TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.minibar_report_adjustment     TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.minibar_refill_task           TO prsystem_api;
--> statement-breakpoint
GRANT SELECT ON platform.cleaning_task                 TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.minibar_usage_report          TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.minibar_usage_report_version  TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.minibar_usage_report_line     TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.minibar_usage_report_movement TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.minibar_report_dispute        TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.minibar_payment_lock          TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.minibar_report_adjustment     TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.minibar_refill_task           TO prsystem_worker;
