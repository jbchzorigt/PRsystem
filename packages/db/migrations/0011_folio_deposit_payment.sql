-- Folio, deposit, payment, and correction: the one consolidated bill a stay
-- carries, the deposit a walk-in leaves and the versioned aggregate that keeps
-- its balance honest, the immutable money ledger, the refund with its reserved
-- amount and its state machine, the financial correction that never edits what
-- it corrects, and the reconciliation of a released refund the provider paid
-- after all.
--
-- Six structural rules run through this migration.
--
-- **One folio per stay.** `stay_folio` is unique on the stay and carries what
-- was charged, what was paid and what the deposit covered; its lines are
-- append-only and idempotent on the thing that produced them, so a repeated
-- posting of the same room charge or minibar report cannot bill a guest twice
-- (`RC-DEC-001`).
--
-- **The deposit balance is arithmetic the database owns.** `deposit_aggregate`
-- holds `received − reversed − allocated − refund_reserved − refunded >= 0` as
-- a CHECK. A pending, unknown or retryable-failed refund keeps its amount
-- reserved, so the same money cannot be allocated to a charge while a provider
-- may still pay it out (`DEP-DEC-007`).
--
-- **Money events are immutable.** `payment_transaction` is append-only: a
-- receipt, a refund, a reversal and a correction are separate rows, and a
-- provider reference is unique per hotel and channel, so a duplicate callback
-- cannot post a second movement (`DEP-DEC-006`, `-007`).
--
-- **A refund is not refunded until the provider says so.** `refund_request`
-- carries the state machine of doc 20 §7. Only `cash not handed` or an
-- authoritative provider void releases a reservation, and a release that is
-- later contradicted by a success freezes the aggregate and opens exactly one
-- reconciliation case (`DEP-DEC-003`, `-009`).
--
-- **A correction is a reversal plus a new record.** `financial_correction`
-- allows one non-terminal request per original transaction, and its execution
-- writes the reversal and the corrected transaction in one step
-- (`DEP-DEC-006`).
--
-- **The late-success case belongs to Platform Operation.** The reconciliation
-- case names the account that claimed it, its terminal outcome, the covered
-- amount and the shortfall posted as a hotel finance event — never a second
-- refund to the guest (`DEP-DEC-010`).
--
-- docs 20 (`DEP-DEC-001`…`-010`), 02 §§3.3–3.4 (`RC-DEC-001`…`-004`, `-006`),
-- 11, 24 §§1–4, 18 §3; ADR-0007 (money), ADR-0009 (append-only), ADR-0011
-- (revision/CAS), ADR-0017 (RLS + roles), ADR-0018 (audit).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- =====================================================================
-- The configured deposit
-- =====================================================================

-- doc 02 §3.4, `RC-DEC-002`: a hotel default between 50,000₮ and 100,000₮, and
-- a room category may override it. A row per scope; the version is what a
-- confirmed stay snapshots, so a later edit reaches only the next check-in.
CREATE TABLE platform.deposit_config (
  config_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id              uuid NOT NULL,
  category_id           uuid,
  amount_mnt            bigint NOT NULL,
  config_version        integer NOT NULL DEFAULT 1,
  updated_by_account_id uuid NOT NULL,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  revision              integer NOT NULL DEFAULT 0,
  CONSTRAINT deposit_config_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT deposit_config_category_fkey FOREIGN KEY (hotel_id, category_id)
    REFERENCES platform.room_category (hotel_id, category_id) ON DELETE RESTRICT,
  CONSTRAINT deposit_config_amount_range CHECK (amount_mnt BETWEEN 50000 AND 100000),
  CONSTRAINT deposit_config_version_positive CHECK (config_version >= 1),
  CONSTRAINT deposit_config_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- One default per hotel, one override per category.
CREATE UNIQUE INDEX deposit_config_default_uq
  ON platform.deposit_config (hotel_id)
  WHERE category_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX deposit_config_category_uq
  ON platform.deposit_config (hotel_id, category_id)
  WHERE category_id IS NOT NULL;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.deposit_config_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.category_id IS DISTINCT FROM OLD.category_id THEN
    RAISE EXCEPTION 'a deposit configuration keeps its scope' USING ERRCODE = '42501';
  END IF;
  IF NEW.config_version <= OLD.config_version THEN
    RAISE EXCEPTION 'a deposit configuration edit advances its version' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposit_config_update_guard
  BEFORE UPDATE ON platform.deposit_config
  FOR EACH ROW EXECUTE FUNCTION platform.deposit_config_guard();
--> statement-breakpoint

-- =====================================================================
-- The consolidated folio
-- =====================================================================

-- `RC-DEC-001`: one bill per stay. The room charge may be taken first and the
-- minibar added later; what remains is `charged − paid − deposit applied`.
CREATE TABLE platform.stay_folio (
  folio_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id            uuid NOT NULL,
  stay_id             uuid NOT NULL,
  room_id             uuid NOT NULL,
  state               text NOT NULL DEFAULT 'OPEN',
  charged_mnt         bigint NOT NULL DEFAULT 0,
  paid_mnt            bigint NOT NULL DEFAULT 0,
  deposit_applied_mnt bigint NOT NULL DEFAULT 0,
  opened_at           timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz,
  reason              text,
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT stay_folio_stay_uq UNIQUE (stay_id),
  CONSTRAINT stay_folio_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT stay_folio_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT stay_folio_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT stay_folio_state_known
    CHECK (state = ANY (ARRAY['OPEN'::text, 'SETTLED'::text, 'VOID'::text])),
  CONSTRAINT stay_folio_amounts_non_negative
    CHECK (charged_mnt >= 0 AND paid_mnt >= 0 AND deposit_applied_mnt >= 0),
  -- A guest is never credited beyond what was charged.
  CONSTRAINT stay_folio_not_overpaid CHECK (paid_mnt + deposit_applied_mnt <= charged_mnt),
  CONSTRAINT stay_folio_settled_shape
    CHECK ((state = 'SETTLED'::text) = (settled_at IS NOT NULL)),
  -- doc 02 §3.3: the folio closes when nothing is left to pay.
  CONSTRAINT stay_folio_settled_balanced
    CHECK (state <> 'SETTLED'::text OR paid_mnt + deposit_applied_mnt = charged_mnt),
  CONSTRAINT stay_folio_void_shape CHECK ((state <> 'VOID'::text) OR (reason IS NOT NULL)),
  CONSTRAINT stay_folio_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  CONSTRAINT stay_folio_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX stay_folio_room_idx ON platform.stay_folio (hotel_id, room_id, state);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.stay_folio_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'a folio and the stay it belongs to are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'OPEN' THEN
    RAISE EXCEPTION 'a terminal folio is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state NOT IN ('OPEN', 'SETTLED', 'VOID') THEN
    RAISE EXCEPTION 'illegal folio transition % -> %', OLD.state, NEW.state USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stay_folio_update_guard
  BEFORE UPDATE ON platform.stay_folio
  FOR EACH ROW EXECUTE FUNCTION platform.stay_folio_guard();
--> statement-breakpoint
CREATE TRIGGER stay_folio_no_delete
  BEFORE DELETE ON platform.stay_folio
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 02 §3.3: the bill broken out by room, minibar and other charges. A line
-- is idempotent on what produced it, so posting the same minibar report or the
-- same room charge twice writes one line.
CREATE TABLE platform.folio_line (
  line_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  folio_id         uuid NOT NULL,
  kind             text NOT NULL,
  source_type      text NOT NULL,
  source_ref       uuid NOT NULL,
  description      text NOT NULL,
  amount_mnt       bigint NOT NULL,
  actor_account_id uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT folio_line_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT folio_line_folio_fkey FOREIGN KEY (folio_id)
    REFERENCES platform.stay_folio (folio_id) ON DELETE RESTRICT,
  CONSTRAINT folio_line_source_uq UNIQUE (folio_id, source_type, source_ref),
  CONSTRAINT folio_line_kind_known
    CHECK (kind = ANY (ARRAY['ROOM'::text, 'MINIBAR'::text, 'OTHER'::text])),
  CONSTRAINT folio_line_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT folio_line_description_bounded CHECK (length(description) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX folio_line_folio_idx ON platform.folio_line (hotel_id, folio_id, created_at);
--> statement-breakpoint
CREATE TRIGGER folio_line_append_only
  BEFORE UPDATE OR DELETE ON platform.folio_line
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER folio_line_no_truncate
  BEFORE TRUNCATE ON platform.folio_line
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The deposit aggregate
-- =====================================================================

-- `DEP-DEC-007`: one versioned row per stay, and the balance invariant is a
-- CHECK rather than a convention. `DEP-DEC-008`: the requirement, the amount
-- and the configuration version are snapshotted at the confirmation and never
-- re-resolved.
CREATE TABLE platform.deposit_aggregate (
  stay_id             uuid PRIMARY KEY,
  hotel_id            uuid NOT NULL,
  source              text NOT NULL,
  required            boolean NOT NULL,
  required_amount_mnt bigint,
  config_scope        text NOT NULL,
  config_version      integer,
  category_id         uuid,
  received_mnt        bigint NOT NULL DEFAULT 0,
  reversed_mnt        bigint NOT NULL DEFAULT 0,
  allocated_mnt       bigint NOT NULL DEFAULT 0,
  refund_reserved_mnt bigint NOT NULL DEFAULT 0,
  refunded_mnt        bigint NOT NULL DEFAULT 0,
  frozen              boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT deposit_aggregate_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT deposit_aggregate_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT deposit_aggregate_source_known
    CHECK (source = ANY (ARRAY['WALK_IN'::text, 'ONLINE'::text])),
  CONSTRAINT deposit_aggregate_scope_known
    CHECK (config_scope = ANY (ARRAY['HOTEL'::text, 'CATEGORY'::text, 'NONE'::text])),
  -- `DEP-DEC-001`, `RC-DEC-003`: a walk-in owes a configured deposit between
  -- 50,000₮ and 100,000₮; a confirmed online booking owes none.
  CONSTRAINT deposit_aggregate_required_shape
    CHECK (required = (source = 'WALK_IN'::text)),
  CONSTRAINT deposit_aggregate_amount_shape
    CHECK (required = (required_amount_mnt IS NOT NULL)
           AND (required_amount_mnt IS NULL
                OR required_amount_mnt BETWEEN 50000 AND 100000)),
  CONSTRAINT deposit_aggregate_config_shape
    CHECK ((config_scope = 'NONE'::text) = (config_version IS NULL)
           AND (config_scope = 'CATEGORY'::text) = (category_id IS NOT NULL)),
  CONSTRAINT deposit_aggregate_amounts_non_negative
    CHECK (received_mnt >= 0 AND reversed_mnt >= 0 AND allocated_mnt >= 0
           AND refund_reserved_mnt >= 0 AND refunded_mnt >= 0),
  -- The invariant the whole phase turns on: what is committed can never exceed
  -- what was actually received and not reversed.
  CONSTRAINT deposit_aggregate_available_non_negative
    CHECK (received_mnt - reversed_mnt - allocated_mnt - refund_reserved_mnt - refunded_mnt >= 0),
  CONSTRAINT deposit_aggregate_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.deposit_aggregate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.required IS DISTINCT FROM OLD.required
     OR NEW.required_amount_mnt IS DISTINCT FROM OLD.required_amount_mnt
     OR NEW.config_scope IS DISTINCT FROM OLD.config_scope
     OR NEW.config_version IS DISTINCT FROM OLD.config_version
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'the deposit requirement and its configuration snapshot are written once (DEP-DEC-008)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  -- Money only ever accumulates: a total that went down would be an edit of
  -- history rather than a new movement.
  IF NEW.received_mnt < OLD.received_mnt
     OR NEW.reversed_mnt < OLD.reversed_mnt
     OR NEW.allocated_mnt < OLD.allocated_mnt
     OR NEW.refunded_mnt < OLD.refunded_mnt THEN
    RAISE EXCEPTION 'a deposit total never decreases; post a reversal instead'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposit_aggregate_update_guard
  BEFORE UPDATE ON platform.deposit_aggregate
  FOR EACH ROW EXECUTE FUNCTION platform.deposit_aggregate_guard();
--> statement-breakpoint
CREATE TRIGGER deposit_aggregate_no_delete
  BEFORE DELETE ON platform.deposit_aggregate
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The money ledger
-- =====================================================================

-- doc 20 §§2, 6, 8: every movement that actually happened, once. A receipt, a
-- refund, a reversal and a corrected record are separate immutable rows; the
-- provider reference is unique per hotel and channel, so a duplicate callback
-- writes nothing new.
CREATE TABLE platform.payment_transaction (
  transaction_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  stay_id                 uuid NOT NULL,
  folio_id                uuid,
  kind                    text NOT NULL,
  channel                 text NOT NULL,
  direction               text NOT NULL,
  amount_mnt              bigint NOT NULL,
  provider_reference      text,
  approval_code           text,
  terminal_id             text,
  original_transaction_id uuid,
  refund_request_id       uuid,
  shift_id                uuid,
  reason                  text,
  actor_account_id        uuid NOT NULL,
  occurred_at             timestamptz NOT NULL DEFAULT now(),
  effective_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_transaction_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT payment_transaction_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT payment_transaction_folio_fkey FOREIGN KEY (folio_id)
    REFERENCES platform.stay_folio (folio_id) ON DELETE RESTRICT,
  CONSTRAINT payment_transaction_original_fkey FOREIGN KEY (original_transaction_id)
    REFERENCES platform.payment_transaction (transaction_id) ON DELETE RESTRICT,
  CONSTRAINT payment_transaction_shift_fkey FOREIGN KEY (hotel_id, shift_id)
    REFERENCES platform.reception_shift (hotel_id, shift_id) ON DELETE RESTRICT,
  CONSTRAINT payment_transaction_kind_known
    CHECK (kind = ANY (ARRAY['DEPOSIT_RECEIPT'::text, 'DEPOSIT_REFUND'::text,
                             'DEPOSIT_REVERSAL'::text, 'FOLIO_PAYMENT'::text,
                             'FOLIO_PAYMENT_REVERSAL'::text, 'CORRECTED_PAYMENT'::text,
                             'LATE_REFUND_COVERED'::text])),
  CONSTRAINT payment_transaction_channel_known
    CHECK (channel = ANY (ARRAY['CASH'::text, 'QPAY'::text, 'CARD_GATEWAY'::text,
                                'MANUAL_POS'::text])),
  CONSTRAINT payment_transaction_direction_known
    CHECK (direction = ANY (ARRAY['IN'::text, 'OUT'::text])),
  CONSTRAINT payment_transaction_amount_positive CHECK (amount_mnt > 0),
  -- doc 20 §6, `DEP-DEC-005`: a manual POS movement is not recorded without
  -- its approval code and reference; an integrated channel carries the
  -- provider's own reference; cash belongs to a shift.
  -- A reversal faces no provider: it is an internal entry that names the
  -- movement it reverses, and the reference stays on that original row.
  CONSTRAINT payment_transaction_pos_shape
    CHECK (channel <> 'MANUAL_POS'::text
           OR kind IN ('DEPOSIT_REVERSAL', 'FOLIO_PAYMENT_REVERSAL')
           OR (provider_reference IS NOT NULL AND approval_code IS NOT NULL)),
  CONSTRAINT payment_transaction_gateway_shape
    CHECK (channel NOT IN ('QPAY', 'CARD_GATEWAY')
           OR kind IN ('DEPOSIT_REVERSAL', 'FOLIO_PAYMENT_REVERSAL')
           OR provider_reference IS NOT NULL),
  CONSTRAINT payment_transaction_cash_shape
    CHECK (channel <> 'CASH'::text OR shift_id IS NOT NULL),
  CONSTRAINT payment_transaction_reversal_shape
    CHECK (kind NOT IN ('DEPOSIT_REVERSAL', 'FOLIO_PAYMENT_REVERSAL', 'CORRECTED_PAYMENT')
           OR original_transaction_id IS NOT NULL),
  CONSTRAINT payment_transaction_refund_shape
    CHECK (kind NOT IN ('DEPOSIT_REFUND', 'LATE_REFUND_COVERED')
           OR refund_request_id IS NOT NULL),
  CONSTRAINT payment_transaction_direction_shape
    CHECK ((direction = 'IN'::text) = (kind IN ('DEPOSIT_RECEIPT', 'FOLIO_PAYMENT',
                                                'CORRECTED_PAYMENT'))),
  CONSTRAINT payment_transaction_reference_bounded
    CHECK ((provider_reference IS NULL OR length(provider_reference) BETWEEN 1 AND 120)
           AND (approval_code IS NULL OR length(approval_code) BETWEEN 1 AND 60)
           AND (terminal_id IS NULL OR length(terminal_id) BETWEEN 1 AND 60)),
  CONSTRAINT payment_transaction_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300)
);
--> statement-breakpoint

-- `DEP-DEC-007`: one movement per provider reference, per hotel and channel.
CREATE UNIQUE INDEX payment_transaction_provider_reference_uq
  ON platform.payment_transaction (hotel_id, channel, provider_reference)
  WHERE provider_reference IS NOT NULL;
--> statement-breakpoint
CREATE INDEX payment_transaction_stay_idx
  ON platform.payment_transaction (hotel_id, stay_id, occurred_at);
--> statement-breakpoint
CREATE INDEX payment_transaction_folio_idx ON platform.payment_transaction (hotel_id, folio_id);
--> statement-breakpoint
CREATE TRIGGER payment_transaction_append_only
  BEFORE UPDATE OR DELETE ON platform.payment_transaction
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_transaction_no_truncate
  BEFORE TRUNCATE ON platform.payment_transaction
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 20 §3: what the deposit paid for, line by line. `DEP-DEC-002`: no reason,
-- no evidence and no second approval — but every allocation is audited and
-- addressable.
CREATE TABLE platform.deposit_allocation (
  allocation_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  stay_id          uuid NOT NULL,
  folio_line_id    uuid NOT NULL,
  amount_mnt       bigint NOT NULL,
  actor_account_id uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_allocation_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT deposit_allocation_deposit_fkey FOREIGN KEY (stay_id)
    REFERENCES platform.deposit_aggregate (stay_id) ON DELETE RESTRICT,
  CONSTRAINT deposit_allocation_line_fkey FOREIGN KEY (folio_line_id)
    REFERENCES platform.folio_line (line_id) ON DELETE RESTRICT,
  CONSTRAINT deposit_allocation_line_uq UNIQUE (folio_line_id),
  CONSTRAINT deposit_allocation_amount_positive CHECK (amount_mnt > 0)
);
--> statement-breakpoint
CREATE INDEX deposit_allocation_stay_idx
  ON platform.deposit_allocation (hotel_id, stay_id, created_at);
--> statement-breakpoint
CREATE TRIGGER deposit_allocation_append_only
  BEFORE UPDATE OR DELETE ON platform.deposit_allocation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER deposit_allocation_no_truncate
  BEFORE TRUNCATE ON platform.deposit_allocation
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The refund and its reservation
-- =====================================================================

-- doc 20 §§4, 5, 7: the request reserves the amount the moment it is raised,
-- and only a provider success or an authoritative release ends the
-- reservation. An alternate channel needs a Manager's approval before it may
-- be sent at all (`DEP-DEC-004`).
CREATE TABLE platform.refund_request (
  request_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  stay_id                 uuid NOT NULL,
  original_transaction_id uuid NOT NULL,
  channel                 text NOT NULL,
  alternate_channel       boolean NOT NULL DEFAULT false,
  amount_mnt              bigint NOT NULL,
  state                   text NOT NULL DEFAULT 'PENDING',
  approval_state          text NOT NULL DEFAULT 'NOT_REQUIRED',
  reason                  text,
  provider_reference      text,
  failure_reason          text,
  requested_by_account_id uuid NOT NULL,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  decided_by_account_id   uuid,
  decided_at              timestamptz,
  released_by_account_id  uuid,
  released_at             timestamptz,
  release_reason          text,
  settled_at              timestamptz,
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT refund_request_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT refund_request_deposit_fkey FOREIGN KEY (stay_id)
    REFERENCES platform.deposit_aggregate (stay_id) ON DELETE RESTRICT,
  CONSTRAINT refund_request_original_fkey FOREIGN KEY (original_transaction_id)
    REFERENCES platform.payment_transaction (transaction_id) ON DELETE RESTRICT,
  CONSTRAINT refund_request_channel_known
    CHECK (channel = ANY (ARRAY['CASH'::text, 'QPAY'::text, 'CARD_GATEWAY'::text,
                                'MANUAL_POS'::text])),
  CONSTRAINT refund_request_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'FAILED'::text, 'SUCCEEDED'::text,
                              'RELEASED'::text, 'RECONCILING'::text, 'RECONCILED'::text])),
  CONSTRAINT refund_request_approval_known
    CHECK (approval_state = ANY (ARRAY['NOT_REQUIRED'::text, 'PENDING'::text,
                                       'APPROVED'::text, 'REJECTED'::text])),
  -- `DEP-DEC-004`: the alternate channel is the only refund that needs a
  -- decision, and it states why the original channel could not be used.
  CONSTRAINT refund_request_alternate_shape
    CHECK (alternate_channel = (approval_state <> 'NOT_REQUIRED'::text)),
  CONSTRAINT refund_request_alternate_reason
    CHECK (NOT alternate_channel OR reason IS NOT NULL),
  CONSTRAINT refund_request_decision_shape
    CHECK ((decided_at IS NULL) = (decided_by_account_id IS NULL)
           AND (approval_state IN ('NOT_REQUIRED', 'PENDING')) = (decided_at IS NULL)),
  CONSTRAINT refund_request_release_shape
    CHECK ((state = 'RELEASED'::text OR state = 'RECONCILING'::text
            OR state = 'RECONCILED'::text) = (released_at IS NOT NULL)
           AND (released_at IS NULL) = (released_by_account_id IS NULL)
           AND (released_at IS NULL) = (release_reason IS NULL)),
  CONSTRAINT refund_request_settled_shape
    CHECK ((state = 'SUCCEEDED'::text) = (settled_at IS NOT NULL)),
  CONSTRAINT refund_request_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT refund_request_reason_bounded
    CHECK ((reason IS NULL OR length(reason) BETWEEN 1 AND 300)
           AND (release_reason IS NULL OR length(release_reason) BETWEEN 1 AND 300)
           AND (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 300)),
  CONSTRAINT refund_request_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- One live refund per receipt: a second request against the same transaction
-- would reserve the same money twice.
CREATE UNIQUE INDEX refund_request_one_live_uq
  ON platform.refund_request (original_transaction_id)
  WHERE state IN ('PENDING', 'FAILED', 'RECONCILING');
--> statement-breakpoint
CREATE INDEX refund_request_stay_idx ON platform.refund_request (hotel_id, stay_id, state);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.refund_request_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.original_transaction_id IS DISTINCT FROM OLD.original_transaction_id
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.alternate_channel IS DISTINCT FROM OLD.alternate_channel
     OR NEW.requested_by_account_id IS DISTINCT FROM OLD.requested_by_account_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'a refund request and the receipt it is against are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state IN ('SUCCEEDED', 'RECONCILED') THEN
    RAISE EXCEPTION 'a terminal refund request is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'PENDING' AND NEW.state IN ('SUCCEEDED', 'FAILED', 'RELEASED'))
      -- doc 20 §7: a failed attempt is retried, and the retry either settles or
      -- fails again; the reservation stood throughout either way.
      OR (OLD.state = 'FAILED' AND NEW.state IN ('PENDING', 'SUCCEEDED', 'RELEASED'))
      -- doc 20 §3.2: a released request the provider paid after all is not a
      -- refund; it is a reconciliation case.
      OR (OLD.state = 'RELEASED' AND NEW.state = 'RECONCILING')
      OR (OLD.state = 'RECONCILING' AND NEW.state = 'RECONCILED')
    ) THEN
    RAISE EXCEPTION 'illegal refund transition % -> %', OLD.state, NEW.state
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
CREATE TRIGGER refund_request_update_guard
  BEFORE UPDATE ON platform.refund_request
  FOR EACH ROW EXECUTE FUNCTION platform.refund_request_guard();
--> statement-breakpoint
CREATE TRIGGER refund_request_no_delete
  BEFORE DELETE ON platform.refund_request
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The financial correction
-- =====================================================================

-- `DEP-DEC-006`: a wrong movement is never edited. One non-terminal request per
-- original transaction; executing it writes the reversal and the corrected
-- record in one step, and both are ordinary immutable ledger rows.
CREATE TABLE platform.financial_correction (
  correction_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                 uuid NOT NULL,
  stay_id                  uuid NOT NULL,
  original_transaction_id  uuid NOT NULL,
  state                    text NOT NULL DEFAULT 'PENDING',
  reason                   text NOT NULL,
  corrected_amount_mnt     bigint,
  corrected_channel        text,
  corrected_reference      text,
  requested_by_account_id  uuid NOT NULL,
  requested_at             timestamptz NOT NULL DEFAULT now(),
  decided_by_account_id    uuid,
  decided_at               timestamptz,
  decision_reason          text,
  reversal_transaction_id  uuid,
  corrected_transaction_id uuid,
  revision                 integer NOT NULL DEFAULT 0,
  CONSTRAINT financial_correction_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT financial_correction_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT financial_correction_original_fkey FOREIGN KEY (original_transaction_id)
    REFERENCES platform.payment_transaction (transaction_id) ON DELETE RESTRICT,
  CONSTRAINT financial_correction_reversal_fkey FOREIGN KEY (reversal_transaction_id)
    REFERENCES platform.payment_transaction (transaction_id) ON DELETE RESTRICT,
  CONSTRAINT financial_correction_corrected_fkey FOREIGN KEY (corrected_transaction_id)
    REFERENCES platform.payment_transaction (transaction_id) ON DELETE RESTRICT,
  CONSTRAINT financial_correction_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'REJECTED'::text, 'EXECUTED'::text])),
  CONSTRAINT financial_correction_decision_shape
    CHECK ((state = 'PENDING'::text) = (decided_at IS NULL)
           AND (decided_at IS NULL) = (decided_by_account_id IS NULL)),
  CONSTRAINT financial_correction_execution_shape
    CHECK ((state = 'EXECUTED'::text) = (reversal_transaction_id IS NOT NULL)),
  CONSTRAINT financial_correction_amount_positive
    CHECK (corrected_amount_mnt IS NULL OR corrected_amount_mnt > 0),
  CONSTRAINT financial_correction_channel_known
    CHECK (corrected_channel IS NULL
           OR corrected_channel = ANY (ARRAY['CASH'::text, 'QPAY'::text, 'CARD_GATEWAY'::text,
                                             'MANUAL_POS'::text])),
  CONSTRAINT financial_correction_reason_bounded
    CHECK (length(reason) BETWEEN 1 AND 300
           AND (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 300)),
  CONSTRAINT financial_correction_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX financial_correction_one_open_uq
  ON platform.financial_correction (original_transaction_id)
  WHERE state = 'PENDING';
--> statement-breakpoint
CREATE INDEX financial_correction_stay_idx
  ON platform.financial_correction (hotel_id, stay_id, state);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.financial_correction_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.original_transaction_id IS DISTINCT FROM OLD.original_transaction_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by_account_id IS DISTINCT FROM OLD.requested_by_account_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'a correction request and what it corrects are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'a decided correction is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state NOT IN ('REJECTED', 'EXECUTED') THEN
    RAISE EXCEPTION 'illegal correction transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER financial_correction_update_guard
  BEFORE UPDATE ON platform.financial_correction
  FOR EACH ROW EXECUTE FUNCTION platform.financial_correction_guard();
--> statement-breakpoint
CREATE TRIGGER financial_correction_no_delete
  BEFORE DELETE ON platform.financial_correction
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The late-success reconciliation and the hotel's finance events
-- =====================================================================

-- `DEP-DEC-010`: exactly one case per released request, claimed and resolved by
-- a Platform Operation account holding `operation.deposit_refund_reconcile`
-- with recent step-up. The terminal outcome either unfreezes the aggregate with
-- no movement at all, or posts the covered refund and the shortfall.
CREATE TABLE platform.deposit_reconciliation_case (
  case_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id               uuid NOT NULL,
  stay_id                uuid NOT NULL,
  refund_request_id      uuid NOT NULL,
  state                  text NOT NULL DEFAULT 'OPEN',
  outcome                text,
  provider_reference     text,
  provider_amount_mnt    bigint,
  covered_amount_mnt     bigint,
  shortfall_amount_mnt   bigint,
  claimed_by_account_id  uuid,
  claimed_at             timestamptz,
  resolved_by_account_id uuid,
  resolved_at            timestamptz,
  resolution_note        text,
  opened_at              timestamptz NOT NULL DEFAULT now(),
  revision               integer NOT NULL DEFAULT 0,
  CONSTRAINT deposit_reconciliation_case_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT deposit_reconciliation_case_request_fkey FOREIGN KEY (refund_request_id)
    REFERENCES platform.refund_request (request_id) ON DELETE RESTRICT,
  CONSTRAINT deposit_reconciliation_case_request_uq UNIQUE (refund_request_id),
  CONSTRAINT deposit_reconciliation_case_state_known
    CHECK (state = ANY (ARRAY['OPEN'::text, 'RECONCILING'::text, 'RESOLVED'::text])),
  CONSTRAINT deposit_reconciliation_case_outcome_known
    CHECK (outcome IS NULL
           OR outcome = ANY (ARRAY['PROVIDER_STATUS_CORRECTED_NOT_SUCCESS'::text,
                                   'PROVIDER_SUCCESS_POSTED'::text])),
  CONSTRAINT deposit_reconciliation_case_claim_shape
    CHECK ((claimed_at IS NULL) = (claimed_by_account_id IS NULL)
           AND (state = 'OPEN'::text) = (claimed_at IS NULL)),
  CONSTRAINT deposit_reconciliation_case_resolution_shape
    CHECK ((state = 'RESOLVED'::text) = (resolved_at IS NOT NULL)
           AND (resolved_at IS NULL) = (resolved_by_account_id IS NULL)
           AND (resolved_at IS NULL) = (outcome IS NULL)),
  -- The posting outcome states both halves of the money, and neither is negative.
  CONSTRAINT deposit_reconciliation_case_posting_shape
    CHECK ((outcome IS DISTINCT FROM 'PROVIDER_SUCCESS_POSTED'::text)
           = (covered_amount_mnt IS NULL AND shortfall_amount_mnt IS NULL)),
  CONSTRAINT deposit_reconciliation_case_amounts_non_negative
    CHECK ((covered_amount_mnt IS NULL OR covered_amount_mnt >= 0)
           AND (shortfall_amount_mnt IS NULL OR shortfall_amount_mnt >= 0)
           AND (provider_amount_mnt IS NULL OR provider_amount_mnt > 0)),
  CONSTRAINT deposit_reconciliation_case_note_bounded
    CHECK (resolution_note IS NULL OR length(resolution_note) BETWEEN 1 AND 300),
  CONSTRAINT deposit_reconciliation_case_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX deposit_reconciliation_case_state_idx
  ON platform.deposit_reconciliation_case (hotel_id, state, opened_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.deposit_reconciliation_case_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.refund_request_id IS DISTINCT FROM OLD.refund_request_id
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at THEN
    RAISE EXCEPTION 'a reconciliation case and the request it is about are immutable'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'RESOLVED' THEN
    RAISE EXCEPTION 'a resolved reconciliation case is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'OPEN' AND NEW.state = 'RECONCILING')
      OR (OLD.state = 'RECONCILING' AND NEW.state = 'RESOLVED')
    ) THEN
    RAISE EXCEPTION 'illegal reconciliation transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  IF OLD.claimed_by_account_id IS NOT NULL
     AND NEW.claimed_by_account_id IS DISTINCT FROM OLD.claimed_by_account_id THEN
    RAISE EXCEPTION 'a claimed case keeps its claimant' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER deposit_reconciliation_case_update_guard
  BEFORE UPDATE ON platform.deposit_reconciliation_case
  FOR EACH ROW EXECUTE FUNCTION platform.deposit_reconciliation_case_guard();
--> statement-breakpoint
CREATE TRIGGER deposit_reconciliation_case_no_delete
  BEFORE DELETE ON platform.deposit_reconciliation_case
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- `DEP-DEC-010`: the part of a late refund the deposit could not cover is the
-- hotel's loss, recorded as its own append-only event rather than by pushing
-- the deposit balance negative.
CREATE TABLE platform.hotel_finance_event (
  event_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id    uuid NOT NULL,
  stay_id     uuid,
  kind        text NOT NULL,
  amount_mnt  bigint NOT NULL,
  reference   text,
  case_id     uuid,
  note        text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hotel_finance_event_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_finance_event_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_finance_event_case_fkey FOREIGN KEY (case_id)
    REFERENCES platform.deposit_reconciliation_case (case_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_finance_event_kind_known
    CHECK (kind = ANY (ARRAY['LATE_REFUND_SHORTFALL'::text])),
  CONSTRAINT hotel_finance_event_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT hotel_finance_event_note_bounded
    CHECK ((note IS NULL OR length(note) BETWEEN 1 AND 300)
           AND (reference IS NULL OR length(reference) BETWEEN 1 AND 120))
);
--> statement-breakpoint
CREATE INDEX hotel_finance_event_hotel_idx
  ON platform.hotel_finance_event (hotel_id, kind, occurred_at);
--> statement-breakpoint
CREATE TRIGGER hotel_finance_event_append_only
  BEFORE UPDATE OR DELETE ON platform.hotel_finance_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER hotel_finance_event_no_truncate
  BEFORE TRUNCATE ON platform.hotel_finance_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Row Level Security
-- =====================================================================

ALTER TABLE platform.deposit_config               ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.deposit_config               FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_folio                   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_folio                   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.folio_line                   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.folio_line                   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.deposit_aggregate            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.deposit_aggregate            FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.payment_transaction          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.payment_transaction          FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.deposit_allocation           ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.deposit_allocation           FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.refund_request               ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.refund_request               FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.financial_correction         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.financial_correction         FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.deposit_reconciliation_case  ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.deposit_reconciliation_case  FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_finance_event          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_finance_event          FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON platform.deposit_config
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.stay_folio
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.folio_line
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.deposit_aggregate
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.payment_transaction
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.deposit_allocation
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.refund_request
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.financial_correction
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.deposit_reconciliation_case
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_finance_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Grants
-- =====================================================================

-- The API writes what a Reception, a Manager and — for the reconciliation case
-- alone — a Platform Operation account does. Nothing it holds lets it rewrite a
-- ledger row, an allocation or a finance event: those are append-only to the
-- database. The worker reads what the shift and finance projections need.
GRANT SELECT, INSERT, UPDATE ON platform.deposit_config              TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.stay_folio                  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.folio_line                  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.deposit_aggregate           TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.payment_transaction         TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.deposit_allocation          TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.refund_request              TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.financial_correction        TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.deposit_reconciliation_case TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.hotel_finance_event         TO prsystem_api;
--> statement-breakpoint
GRANT SELECT ON platform.deposit_config              TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.stay_folio                  TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.folio_line                  TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.deposit_aggregate           TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.payment_transaction         TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.deposit_allocation          TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.refund_request              TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.financial_correction        TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.deposit_reconciliation_case TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.hotel_finance_event         TO prsystem_worker;
