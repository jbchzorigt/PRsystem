-- Shift, cash drawer, expense, and hotel finance: the physical cash locations a
-- hotel keeps, the Reception shift as the unit of accountability over one of
-- them, the typed immutable cash ledger, the transfers between locations, the
-- approvals a withdrawal needs, and the expense whose approval is not yet a
-- payment.
--
-- Six structural rules run through this migration.
--
-- **One active shift per drawer, one per Reception.** Both are partial unique
-- indexes rather than service checks, so two Receptions opening on one drawer
-- run into the database (`CASH-DEC-001`).
--
-- **The operational state and the financial review are separate columns.** doc
-- 03 §6 keeps them apart on purpose: `Өөрөө хаасан + Hotel Admin review
-- шаардлагатай` is a valid pair, and collapsing them into one field would make
-- it unsayable (`SHIFT-DEC-001`).
--
-- **The opening balance is the amount actually counted.** It is written once
-- with the shift and never overwritten; a later correction is a new movement in
-- the shift it actually happened in (`SHIFT-DEC-002`, `-006`, `CASH-DEC-009`).
--
-- **The ledger is typed and immutable.** `cash_movement` is append-only, every
-- drawer movement names the shift it belongs to, and a mistake is a reversal
-- plus a corrected movement rather than an edit (`CASH-DEC-004`).
--
-- **A transfer is two movements or none.** The source and destination drawers
-- and their shifts are pinned when it is initiated; the recipient's count is
-- what completes it, and a shift with a transfer still pending cannot close
-- (`CASH-DEC-006`).
--
-- **An approval is not an outflow.** An approved expense moves no cash; only a
-- cash-method execution writes `PAID_CASH_EXPENSE`, and a card or bank payment
-- writes no drawer movement at all (`CASH-DEC-005`, `FIN-DEC-005`).
--
-- docs 24 (`CASH-DEC-001`…`-010`), 03 (`SHIFT-DEC-001`…`-007`), 23
-- (`FIN-DEC-005`), 02 §§3.5–3.6 (`RC-DEC-009`, `-038`), 18 §3; ADR-0007
-- (money), ADR-0009 (append-only), ADR-0011 (revision/CAS), ADR-0017
-- (RLS + roles), ADR-0018 (audit).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- =====================================================================
-- Cash locations: what Phase 05 provisioned, extended
-- =====================================================================

-- doc 24 §2: Phase 05's activation already creates `platform.cash_location` and
-- the hotel's default drawer with it, so this phase extends that row rather
-- than inventing a second table: the float a drawer is expected to hold, where
-- it physically is, and who created it when a Hotel Admin adds one later. The
-- identity, the kind and the default-drawer flag stay under Phase 05's guard.
ALTER TABLE platform.cash_location
  ADD COLUMN physical_location     text,
  ADD COLUMN configured_float_mnt  bigint,
  ADD COLUMN created_by_account_id uuid;
--> statement-breakpoint

ALTER TABLE platform.cash_location
  ADD CONSTRAINT cash_location_float_shape
    CHECK (configured_float_mnt IS NULL
           OR (kind = 'DRAWER'::text AND configured_float_mnt >= 0)),
  ADD CONSTRAINT cash_location_physical_bounded
    CHECK (physical_location IS NULL OR length(physical_location) BETWEEN 1 AND 200);
--> statement-breakpoint

-- doc 24 §2.1: a hotel keeps at most one safe.
CREATE UNIQUE INDEX cash_location_one_safe_uq
  ON platform.cash_location (hotel_id)
  WHERE kind = 'SAFE'::text;
--> statement-breakpoint

-- =====================================================================
-- The Reception shift over a drawer
-- =====================================================================

-- doc 03 §§4–6: Phase 08 created the shift as the bound a check-in needs —
-- who opened it and when. Phase 11 makes it the unit of cash accountability:
-- the drawer it is over, the amount actually counted at its opening, the
-- expected and counted cash at its close, and two separate states, because the
-- money changing hands and the Manager's review are different questions
-- (`SHIFT-DEC-001`).
ALTER TABLE platform.reception_shift
  ADD COLUMN location_id            uuid,
  ADD COLUMN opening_balance_mnt    bigint,
  ADD COLUMN expected_cash_mnt      bigint,
  ADD COLUMN counted_cash_mnt       bigint,
  ADD COLUMN variance_mnt           bigint,
  ADD COLUMN incoming_counted_mnt   bigint,
  ADD COLUMN handed_to_account_id   uuid,
  ADD COLUMN review_state           text NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN reviewed_by_account_id uuid,
  ADD COLUMN reviewed_at            timestamptz,
  ADD COLUMN review_reason          text,
  ADD COLUMN self_reviewed          boolean NOT NULL DEFAULT false,
  ADD COLUMN close_reason           text;
--> statement-breakpoint

ALTER TABLE platform.reception_shift
  ADD CONSTRAINT reception_shift_location_fkey FOREIGN KEY (hotel_id, location_id)
    REFERENCES platform.cash_location (hotel_id, cash_location_id) ON DELETE RESTRICT;
--> statement-breakpoint

-- The operational states of doc 03 §6.1, replacing the two Phase 08 placeholders.
ALTER TABLE platform.reception_shift
  DROP CONSTRAINT reception_shift_state_known;
--> statement-breakpoint
ALTER TABLE platform.reception_shift
  ADD CONSTRAINT reception_shift_state_known
    CHECK (state = ANY (ARRAY['OPEN'::text, 'CLOSING'::text, 'HANDED_OVER'::text,
                              'RECOUNT_REQUIRED'::text, 'CASH_ACCEPTED'::text,
                              'SELF_CLOSED'::text, 'CLOSED'::text]));
--> statement-breakpoint

ALTER TABLE platform.reception_shift
  DROP CONSTRAINT reception_shift_closed_shape;
--> statement-breakpoint
ALTER TABLE platform.reception_shift
  ADD CONSTRAINT reception_shift_closed_shape
    CHECK ((state = ANY (ARRAY['SELF_CLOSED'::text, 'CLOSED'::text]))
           = (closed_at IS NOT NULL AND closed_by_account_id IS NOT NULL));
--> statement-breakpoint

ALTER TABLE platform.reception_shift
  ADD CONSTRAINT reception_shift_review_state_known
    CHECK (review_state = ANY (ARRAY['NOT_REQUIRED'::text, 'PENDING_MANAGER'::text,
                                     'PENDING_HOTEL_ADMIN'::text, 'DISPUTED'::text,
                                     'RESOLVED'::text])),
  -- doc 03 §4.6: the variance is the counted cash less the expected cash, and
  -- it is stored beside both rather than derived on read.
  ADD CONSTRAINT reception_shift_variance_shape
    CHECK ((counted_cash_mnt IS NULL AND expected_cash_mnt IS NULL AND variance_mnt IS NULL)
           OR (counted_cash_mnt IS NOT NULL AND expected_cash_mnt IS NOT NULL
               AND variance_mnt = counted_cash_mnt - expected_cash_mnt)),
  ADD CONSTRAINT reception_shift_opening_non_negative
    CHECK (opening_balance_mnt IS NULL OR opening_balance_mnt >= 0),
  ADD CONSTRAINT reception_shift_counted_non_negative
    CHECK ((counted_cash_mnt IS NULL OR counted_cash_mnt >= 0)
           AND (incoming_counted_mnt IS NULL OR incoming_counted_mnt >= 0)),
  ADD CONSTRAINT reception_shift_review_shape
    CHECK ((reviewed_at IS NULL) = (reviewed_by_account_id IS NULL)),
  ADD CONSTRAINT reception_shift_reason_bounded
    CHECK ((review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 300)
           AND (close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 300));
--> statement-breakpoint

-- One active shift per drawer, and one per Reception account.
DROP INDEX platform.reception_shift_one_open_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX reception_shift_one_active_per_drawer_uq
  ON platform.reception_shift (hotel_id, location_id)
  WHERE state <> ALL (ARRAY['SELF_CLOSED'::text, 'CLOSED'::text]);
--> statement-breakpoint
CREATE UNIQUE INDEX reception_shift_one_active_per_account_uq
  ON platform.reception_shift (hotel_id, opened_by_account_id)
  WHERE state <> ALL (ARRAY['SELF_CLOSED'::text, 'CLOSED'::text]);
--> statement-breakpoint
CREATE INDEX reception_shift_review_idx
  ON platform.reception_shift (hotel_id, review_state, opened_at);
--> statement-breakpoint

-- doc 03 §5: the operational states move forward only, and a closed shift is
-- never reopened — a rejection resolves through `DISPUTED` and a correction
-- (`SHIFT-DEC-005`).
CREATE OR REPLACE FUNCTION platform.reception_shift_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.shift_id IS DISTINCT FROM OLD.shift_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.opened_by_account_id IS DISTINCT FROM OLD.opened_by_account_id
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.location_id IS DISTINCT FROM OLD.location_id THEN
    RAISE EXCEPTION 'a shift identity and its opening are immutable' USING ERRCODE = '42501';
  END IF;
  -- `SHIFT-DEC-002`, `-006`: the amount counted at the opening is written with
  -- the shift and never rewritten.
  IF OLD.opening_balance_mnt IS NOT NULL
     AND NEW.opening_balance_mnt IS DISTINCT FROM OLD.opening_balance_mnt THEN
    RAISE EXCEPTION 'an opening balance is written once (SHIFT-DEC-006)' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  IF OLD.state IN ('SELF_CLOSED', 'CLOSED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a closed shift is never reopened' USING ERRCODE = '22023';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'OPEN' AND NEW.state IN ('CLOSING', 'SELF_CLOSED'))
      OR (OLD.state = 'CLOSING' AND NEW.state IN ('HANDED_OVER', 'SELF_CLOSED'))
      OR (OLD.state = 'HANDED_OVER' AND NEW.state IN ('RECOUNT_REQUIRED', 'CASH_ACCEPTED'))
      OR (OLD.state = 'RECOUNT_REQUIRED' AND NEW.state IN ('HANDED_OVER', 'CASH_ACCEPTED'))
      OR (OLD.state = 'CASH_ACCEPTED' AND NEW.state = 'CLOSED')
    ) THEN
    RAISE EXCEPTION 'illegal shift transition % -> %', OLD.state, NEW.state USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- =====================================================================
-- The cash ledger
-- =====================================================================

-- doc 24 §§4–5: every movement that actually happened, typed, immutable, and
-- tied to the shift it belongs to when it is a drawer movement. A safe movement
-- has no shift, because a safe takes none (`CASH-DEC-002`, `-004`).
CREATE TABLE platform.cash_movement (
  movement_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id               uuid NOT NULL,
  location_id            uuid NOT NULL,
  shift_id               uuid,
  movement_type          text NOT NULL,
  direction              text NOT NULL,
  amount_mnt             bigint NOT NULL,
  effective_at           timestamptz NOT NULL DEFAULT now(),
  reason                 text,
  reference              text,
  transfer_id            uuid,
  expense_id             uuid,
  -- The movement points at the request and the expense it settles; the reverse
  -- pointers are kept as ids without a constraint, so the two tables do not
  -- reference each other in a cycle.
  request_id             uuid,
  payment_transaction_id uuid,
  original_movement_id   uuid,
  actor_account_id       uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cash_movement_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT cash_movement_location_fkey FOREIGN KEY (hotel_id, location_id)
    REFERENCES platform.cash_location (hotel_id, cash_location_id) ON DELETE RESTRICT,
  CONSTRAINT cash_movement_shift_fkey FOREIGN KEY (hotel_id, shift_id)
    REFERENCES platform.reception_shift (hotel_id, shift_id) ON DELETE RESTRICT,
  CONSTRAINT cash_movement_payment_fkey FOREIGN KEY (payment_transaction_id)
    REFERENCES platform.payment_transaction (transaction_id) ON DELETE RESTRICT,
  CONSTRAINT cash_movement_original_fkey FOREIGN KEY (original_movement_id)
    REFERENCES platform.cash_movement (movement_id) ON DELETE RESTRICT,
  CONSTRAINT cash_movement_type_known
    CHECK (movement_type = ANY (ARRAY['INITIAL_FLOAT'::text, 'SERVICE_CASH_PAYMENT'::text,
                                      'DEPOSIT_CASH_RECEIPT'::text, 'SERVICE_CASH_REFUND'::text,
                                      'DEPOSIT_CASH_REFUND'::text, 'PAID_CASH_EXPENSE'::text,
                                      'CASH_TOP_UP'::text, 'DRAWER_TRANSFER_IN'::text,
                                      'DRAWER_TRANSFER_OUT'::text, 'SAFE_TRANSFER_IN'::text,
                                      'SAFE_TRANSFER_OUT'::text, 'BANK_DEPOSIT_OUT'::text,
                                      'OWNER_OTHER_WITHDRAWAL'::text, 'CASH_CORRECTION_IN'::text,
                                      'CASH_CORRECTION_OUT'::text])),
  CONSTRAINT cash_movement_direction_known
    CHECK (direction = ANY (ARRAY['IN'::text, 'OUT'::text])),
  -- doc 24 §5: the direction is a property of the type, not of the caller.
  CONSTRAINT cash_movement_direction_shape
    CHECK ((direction = 'IN'::text)
           = (movement_type = ANY (ARRAY['INITIAL_FLOAT'::text, 'SERVICE_CASH_PAYMENT'::text,
                                         'DEPOSIT_CASH_RECEIPT'::text, 'CASH_TOP_UP'::text,
                                         'DRAWER_TRANSFER_IN'::text, 'SAFE_TRANSFER_IN'::text,
                                         'CASH_CORRECTION_IN'::text]))),
  CONSTRAINT cash_movement_amount_positive CHECK (amount_mnt > 0),
  -- doc 24 §2.2: a drawer movement belongs to the drawer's active shift; the
  -- one-off initial float precedes the first shift, and a safe takes none.
  CONSTRAINT cash_movement_transfer_shape
    CHECK (movement_type NOT IN ('DRAWER_TRANSFER_IN', 'DRAWER_TRANSFER_OUT',
                                 'SAFE_TRANSFER_IN', 'SAFE_TRANSFER_OUT')
           OR transfer_id IS NOT NULL),
  CONSTRAINT cash_movement_expense_shape
    CHECK ((movement_type = 'PAID_CASH_EXPENSE'::text) = (expense_id IS NOT NULL)),
  CONSTRAINT cash_movement_request_shape
    CHECK (movement_type NOT IN ('BANK_DEPOSIT_OUT', 'OWNER_OTHER_WITHDRAWAL')
           OR request_id IS NOT NULL),
  CONSTRAINT cash_movement_correction_shape
    CHECK (movement_type NOT IN ('CASH_CORRECTION_IN', 'CASH_CORRECTION_OUT')
           OR (reason IS NOT NULL AND original_movement_id IS NOT NULL)),
  CONSTRAINT cash_movement_top_up_shape
    CHECK (movement_type <> 'CASH_TOP_UP'::text OR reason IS NOT NULL),
  CONSTRAINT cash_movement_reason_bounded
    CHECK ((reason IS NULL OR length(reason) BETWEEN 1 AND 300)
           AND (reference IS NULL OR length(reference) BETWEEN 1 AND 120))
);
--> statement-breakpoint

-- doc 24 §3: the initial float happens once per drawer.
CREATE UNIQUE INDEX cash_movement_one_initial_float_uq
  ON platform.cash_movement (location_id)
  WHERE movement_type = 'INITIAL_FLOAT'::text;
--> statement-breakpoint
CREATE INDEX cash_movement_shift_idx ON platform.cash_movement (hotel_id, shift_id, effective_at);
--> statement-breakpoint
CREATE INDEX cash_movement_location_idx
  ON platform.cash_movement (hotel_id, location_id, effective_at);
--> statement-breakpoint
CREATE INDEX cash_movement_transfer_idx ON platform.cash_movement (hotel_id, transfer_id);
--> statement-breakpoint
CREATE TRIGGER cash_movement_append_only
  BEFORE UPDATE OR DELETE ON platform.cash_movement
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER cash_movement_no_truncate
  BEFORE TRUNCATE ON platform.cash_movement
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Transfers between locations
-- =====================================================================

-- doc 24 §9.1–9.2, `CASH-DEC-006`: the two drawers and the two shifts are
-- pinned when the transfer is initiated, and the recipient's own count is what
-- completes it. A pending transfer is in no balance, and a cancellation is a
-- recount rather than a movement.
CREATE TABLE platform.cash_transfer (
  transfer_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                 uuid NOT NULL,
  kind                     text NOT NULL,
  source_location_id       uuid NOT NULL,
  source_shift_id          uuid,
  destination_location_id  uuid NOT NULL,
  destination_shift_id     uuid,
  amount_mnt               bigint NOT NULL,
  state                    text NOT NULL DEFAULT 'PENDING',
  reason                   text,
  initiated_by_account_id  uuid NOT NULL,
  initiated_at             timestamptz NOT NULL DEFAULT now(),
  confirmed_by_account_id  uuid,
  confirmed_at             timestamptz,
  confirmed_counted_mnt    bigint,
  cancelled_by_account_id  uuid,
  cancelled_at             timestamptz,
  cancel_recount_mnt       bigint,
  cancel_reason            text,
  revision                 integer NOT NULL DEFAULT 0,
  CONSTRAINT cash_transfer_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT cash_transfer_source_fkey FOREIGN KEY (hotel_id, source_location_id)
    REFERENCES platform.cash_location (hotel_id, cash_location_id) ON DELETE RESTRICT,
  CONSTRAINT cash_transfer_destination_fkey FOREIGN KEY (hotel_id, destination_location_id)
    REFERENCES platform.cash_location (hotel_id, cash_location_id) ON DELETE RESTRICT,
  CONSTRAINT cash_transfer_source_shift_fkey FOREIGN KEY (hotel_id, source_shift_id)
    REFERENCES platform.reception_shift (hotel_id, shift_id) ON DELETE RESTRICT,
  CONSTRAINT cash_transfer_destination_shift_fkey FOREIGN KEY (hotel_id, destination_shift_id)
    REFERENCES platform.reception_shift (hotel_id, shift_id) ON DELETE RESTRICT,
  CONSTRAINT cash_transfer_kind_known
    CHECK (kind = ANY (ARRAY['DRAWER_TO_DRAWER'::text, 'DRAWER_SAFE'::text])),
  CONSTRAINT cash_transfer_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'COMPLETED'::text, 'CANCELLED'::text])),
  CONSTRAINT cash_transfer_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT cash_transfer_locations_differ
    CHECK (source_location_id <> destination_location_id),
  -- A drawer-to-drawer transfer names both shifts; a safe side has none.
  CONSTRAINT cash_transfer_shift_shape
    CHECK (kind <> 'DRAWER_TO_DRAWER'::text
           OR (source_shift_id IS NOT NULL AND destination_shift_id IS NOT NULL)),
  CONSTRAINT cash_transfer_confirmation_shape
    CHECK ((state = 'COMPLETED'::text)
           = (confirmed_at IS NOT NULL AND confirmed_by_account_id IS NOT NULL)),
  CONSTRAINT cash_transfer_cancellation_shape
    CHECK ((state = 'CANCELLED'::text)
           = (cancelled_at IS NOT NULL AND cancelled_by_account_id IS NOT NULL
              AND cancel_reason IS NOT NULL)),
  CONSTRAINT cash_transfer_counted_non_negative
    CHECK ((confirmed_counted_mnt IS NULL OR confirmed_counted_mnt >= 0)
           AND (cancel_recount_mnt IS NULL OR cancel_recount_mnt >= 0)),
  CONSTRAINT cash_transfer_reason_bounded
    CHECK ((reason IS NULL OR length(reason) BETWEEN 1 AND 300)
           AND (cancel_reason IS NULL OR length(cancel_reason) BETWEEN 1 AND 300)),
  CONSTRAINT cash_transfer_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX cash_transfer_source_idx
  ON platform.cash_transfer (hotel_id, source_shift_id, state);
--> statement-breakpoint
CREATE INDEX cash_transfer_destination_idx
  ON platform.cash_transfer (hotel_id, destination_shift_id, state);
--> statement-breakpoint

ALTER TABLE platform.cash_movement
  ADD CONSTRAINT cash_movement_transfer_fkey FOREIGN KEY (transfer_id)
    REFERENCES platform.cash_transfer (transfer_id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.cash_transfer_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.source_location_id IS DISTINCT FROM OLD.source_location_id
     OR NEW.destination_location_id IS DISTINCT FROM OLD.destination_location_id
     OR NEW.source_shift_id IS DISTINCT FROM OLD.source_shift_id
     OR NEW.destination_shift_id IS DISTINCT FROM OLD.destination_shift_id
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.initiated_by_account_id IS DISTINCT FROM OLD.initiated_by_account_id
     OR NEW.initiated_at IS DISTINCT FROM OLD.initiated_at THEN
    RAISE EXCEPTION 'a transfer and the drawers and shifts it was raised on are immutable (CASH-DEC-006)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'a resolved transfer is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state NOT IN ('PENDING', 'COMPLETED', 'CANCELLED') THEN
    RAISE EXCEPTION 'illegal transfer transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cash_transfer_update_guard
  BEFORE UPDATE ON platform.cash_transfer
  FOR EACH ROW EXECUTE FUNCTION platform.cash_transfer_guard();
--> statement-breakpoint
CREATE TRIGGER cash_transfer_no_delete
  BEFORE DELETE ON platform.cash_transfer
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Bank deposits and owner withdrawals
-- =====================================================================

-- doc 24 §§9.3–9.4, `CASH-DEC-007`: both leave the hotel's physical cash and
-- neither is an expense. A bank deposit states its reference or receipt; a
-- withdrawal states its recipient. A Hotel Admin may raise and approve one
-- itself, and that is audited as self-approved.
CREATE TABLE platform.cash_request (
  request_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  kind                    text NOT NULL,
  location_id             uuid NOT NULL,
  shift_id                uuid,
  amount_mnt              bigint NOT NULL,
  state                   text NOT NULL DEFAULT 'PENDING',
  reference               text,
  recipient               text,
  reason                  text NOT NULL,
  self_approved           boolean NOT NULL DEFAULT false,
  requested_by_account_id uuid NOT NULL,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  decided_by_account_id   uuid,
  decided_at              timestamptz,
  decision_reason         text,
  movement_id             uuid,
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT cash_request_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT cash_request_location_fkey FOREIGN KEY (hotel_id, location_id)
    REFERENCES platform.cash_location (hotel_id, cash_location_id) ON DELETE RESTRICT,
  CONSTRAINT cash_request_shift_fkey FOREIGN KEY (hotel_id, shift_id)
    REFERENCES platform.reception_shift (hotel_id, shift_id) ON DELETE RESTRICT,
  CONSTRAINT cash_request_kind_known
    CHECK (kind = ANY (ARRAY['BANK_DEPOSIT'::text, 'OWNER_WITHDRAWAL'::text])),
  CONSTRAINT cash_request_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])),
  CONSTRAINT cash_request_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT cash_request_bank_shape
    CHECK (kind <> 'BANK_DEPOSIT'::text OR reference IS NOT NULL),
  CONSTRAINT cash_request_withdrawal_shape
    CHECK (kind <> 'OWNER_WITHDRAWAL'::text OR recipient IS NOT NULL),
  CONSTRAINT cash_request_decision_shape
    CHECK ((state = 'PENDING'::text) = (decided_at IS NULL)
           AND (decided_at IS NULL) = (decided_by_account_id IS NULL)),
  CONSTRAINT cash_request_movement_shape
    CHECK (movement_id IS NULL OR state = 'APPROVED'::text),
  CONSTRAINT cash_request_text_bounded
    CHECK (length(reason) BETWEEN 1 AND 300
           AND (reference IS NULL OR length(reference) BETWEEN 1 AND 120)
           AND (recipient IS NULL OR length(recipient) BETWEEN 1 AND 200)
           AND (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 300)),
  CONSTRAINT cash_request_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX cash_request_state_idx ON platform.cash_request (hotel_id, state, requested_at);
--> statement-breakpoint

ALTER TABLE platform.cash_movement
  ADD CONSTRAINT cash_movement_request_fkey FOREIGN KEY (request_id)
    REFERENCES platform.cash_request (request_id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.cash_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.location_id IS DISTINCT FROM OLD.location_id
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.requested_by_account_id IS DISTINCT FROM OLD.requested_by_account_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'a cash request and what it asked for are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'REJECTED' OR (OLD.state = 'APPROVED' AND OLD.movement_id IS NOT NULL) THEN
    RAISE EXCEPTION 'a resolved cash request is immutable' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER cash_request_update_guard
  BEFORE UPDATE ON platform.cash_request
  FOR EACH ROW EXECUTE FUNCTION platform.cash_request_guard();
--> statement-breakpoint
CREATE TRIGGER cash_request_no_delete
  BEFORE DELETE ON platform.cash_request
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The expense
-- =====================================================================

-- doc 24 §8, `FIN-DEC-005`, `CASH-DEC-005`: `Draft → Submitted → Approved for
-- payment → Paid | Rejected`. An approval moves no money; only the execution
-- does, and only a cash execution writes a drawer movement. A card or bank
-- payment records its own reference and touches no drawer.
CREATE TABLE platform.expense (
  expense_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  category                text NOT NULL,
  description             text NOT NULL,
  amount_mnt              bigint NOT NULL,
  method                  text NOT NULL,
  state                   text NOT NULL DEFAULT 'DRAFT',
  self_approved           boolean NOT NULL DEFAULT false,
  created_by_account_id   uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  submitted_at            timestamptz,
  decided_by_account_id   uuid,
  decided_at              timestamptz,
  decision_reason         text,
  paid_by_account_id      uuid,
  paid_at                 timestamptz,
  location_id             uuid,
  shift_id                uuid,
  movement_id             uuid,
  provider_reference      text,
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT expense_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT expense_location_fkey FOREIGN KEY (hotel_id, location_id)
    REFERENCES platform.cash_location (hotel_id, cash_location_id) ON DELETE RESTRICT,
  CONSTRAINT expense_shift_fkey FOREIGN KEY (hotel_id, shift_id)
    REFERENCES platform.reception_shift (hotel_id, shift_id) ON DELETE RESTRICT,
  CONSTRAINT expense_method_known
    CHECK (method = ANY (ARRAY['CASH'::text, 'CARD_POS'::text, 'BANK_QPAY'::text])),
  CONSTRAINT expense_state_known
    CHECK (state = ANY (ARRAY['DRAFT'::text, 'SUBMITTED'::text, 'APPROVED'::text,
                              'PAID'::text, 'REJECTED'::text])),
  CONSTRAINT expense_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT expense_submitted_shape
    CHECK ((state = 'DRAFT'::text) = (submitted_at IS NULL)),
  CONSTRAINT expense_decision_shape
    CHECK ((state IN ('APPROVED', 'PAID', 'REJECTED')) = (decided_at IS NOT NULL)
           AND (decided_at IS NULL) = (decided_by_account_id IS NULL)),
  -- `CASH-DEC-005`: a paid cash expense has its drawer movement; a paid card or
  -- bank expense has its provider reference and no movement at all.
  CONSTRAINT expense_paid_shape
    CHECK ((state = 'PAID'::text) = (paid_at IS NOT NULL AND paid_by_account_id IS NOT NULL)),
  CONSTRAINT expense_cash_payment_shape
    CHECK (state <> 'PAID'::text OR method <> 'CASH'::text
           OR (movement_id IS NOT NULL AND shift_id IS NOT NULL AND location_id IS NOT NULL)),
  CONSTRAINT expense_non_cash_payment_shape
    CHECK (method = 'CASH'::text OR (movement_id IS NULL AND shift_id IS NULL)),
  CONSTRAINT expense_non_cash_reference_shape
    CHECK (state <> 'PAID'::text OR method = 'CASH'::text OR provider_reference IS NOT NULL),
  CONSTRAINT expense_text_bounded
    CHECK (length(category) BETWEEN 1 AND 80
           AND length(description) BETWEEN 1 AND 300
           AND (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 300)
           AND (provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 120)),
  CONSTRAINT expense_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX expense_state_idx ON platform.expense (hotel_id, state, created_at);
--> statement-breakpoint

ALTER TABLE platform.cash_movement
  ADD CONSTRAINT cash_movement_expense_fkey FOREIGN KEY (expense_id)
    REFERENCES platform.expense (expense_id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.expense_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.created_by_account_id IS DISTINCT FROM OLD.created_by_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an expense keeps its author and its creation' USING ERRCODE = '42501';
  END IF;
  -- doc 24 §8.1: the execution never changes what was approved.
  IF OLD.state IN ('APPROVED', 'PAID', 'REJECTED')
     AND (NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
          OR NEW.category IS DISTINCT FROM OLD.category
          OR NEW.method IS DISTINCT FROM OLD.method) THEN
    RAISE EXCEPTION 'a decided expense keeps its amount, category and method (FIN-DEC-005)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state IN ('PAID', 'REJECTED') THEN
    RAISE EXCEPTION 'a terminal expense is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'DRAFT' AND NEW.state IN ('SUBMITTED', 'REJECTED'))
      OR (OLD.state = 'SUBMITTED' AND NEW.state IN ('APPROVED', 'REJECTED'))
      OR (OLD.state = 'APPROVED' AND NEW.state = 'PAID')
    ) THEN
    RAISE EXCEPTION 'illegal expense transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER expense_update_guard
  BEFORE UPDATE ON platform.expense
  FOR EACH ROW EXECUTE FUNCTION platform.expense_guard();
--> statement-breakpoint
CREATE TRIGGER expense_no_delete
  BEFORE DELETE ON platform.expense
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Row Level Security
-- =====================================================================

ALTER TABLE platform.cash_movement  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.cash_movement  FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.cash_transfer  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.cash_transfer  FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.cash_request   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.cash_request   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.expense        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.expense        FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON platform.cash_movement
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.cash_transfer
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.cash_request
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.expense
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Grants
-- =====================================================================

-- `platform.cash_location` keeps the row-level security and the policy Phase 05
-- gave it. Its grants widen here for the first time: doc 24 §2.1 lets a Hotel
-- Admin add a drawer or the hotel's one safe, and set the float a drawer is
-- expected to hold, so the API needs `INSERT` and `UPDATE` on it beside the
-- `SELECT` provisioning left, and the worker reads it for the same finance
-- projections it reads the ledger for.
--
-- The API writes what a Reception, a Manager and a Hotel Admin do. The ledger
-- itself is append-only to the database: no runtime holds `UPDATE` on it, so a
-- posted movement is corrected by a new one and never rewritten. The worker
-- reads what the finance projections need.
GRANT INSERT, UPDATE         ON platform.cash_location TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.cash_movement TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.cash_transfer TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.cash_request  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.expense       TO prsystem_api;
--> statement-breakpoint
GRANT SELECT ON platform.cash_location TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.cash_movement TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.cash_transfer TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.cash_request  TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.expense       TO prsystem_worker;
