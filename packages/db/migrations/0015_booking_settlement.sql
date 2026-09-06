-- =====================================================================
-- 0015 — Online payment, refund, commission and settlement
--
-- Phase 13 took the booking as far as the money: a hold, a capture, a terminal
-- transition, and — where a capture arrived too late or twice — a refund
-- *obligation* recorded and settled by nobody. This migration is the axis that
-- settles it (`BK-DEC-003`, `-008`, `-010`, `-011`; `PAY-DEC-001`, `-003`,
-- `-004`, `-005`, `-007`, `-008`, `-009`).
--
-- Four rules shape every table here.
--
-- **There is no default commission.** `PAY-DEC-001` refuses a fixed 5% fallback,
-- so `commission_rate_bps` has no DEFAULT and no code path invents one: a hotel
-- with no active contract cannot take an online booking payment at all. The
-- rate is snapshotted onto the payable at confirmation and a later contract
-- never reprices a booking that has already been paid.
--
-- **The arithmetic is a constraint, not a convention.** Commission base,
-- `ROUND_HALF_UP` and hotel payable are CHECKs on the row, in integer MNT and
-- integer basis points. `(base * bps + 5000) / 10000` on non-negative bigints is
-- exactly ROUND_HALF_UP, rounded once, and the database is what refuses a row
-- that rounds differently.
--
-- **The gateway fee is the platform's.** `provider_fee_mnt` is recorded against
-- the payment and appears in no term of `hotel_payable_mnt`. It cannot be
-- deducted from a payout by a mistake in application code, because there is
-- nowhere in the formula for it to go.
--
-- **A financial row is never edited.** Every money movement is an append-only
-- ledger event; a correction is another event, and the payable's running totals
-- are the sum the CHECKs keep honest.
-- =====================================================================

-- =====================================================================
-- The cancellation policy the guest was shown
-- =====================================================================

-- doc 11 §5: the policy version and the free-cancellation deadline are shown
-- before payment and snapshotted on the booking. They are written when the hold
-- is created — which is when the guest sees them — and frozen from then on, so
-- the deadline that decides a refund is the one the guest actually agreed to.
ALTER TABLE platform.booking
  ADD COLUMN cancellation_policy_version integer;
--> statement-breakpoint
ALTER TABLE platform.booking
  ADD COLUMN free_cancellation_until timestamptz;
--> statement-breakpoint
ALTER TABLE platform.booking
  ADD CONSTRAINT booking_confirmed_has_policy
    CHECK (state <> ALL (ARRAY['CONFIRMED'::text, 'CHECKED_IN'::text, 'COMPLETED'::text])
           OR (cancellation_policy_version IS NOT NULL
               AND free_cancellation_until IS NOT NULL));
--> statement-breakpoint
ALTER TABLE platform.booking
  ADD CONSTRAINT booking_policy_version_positive
    CHECK (cancellation_policy_version IS NULL OR cancellation_policy_version > 0);
--> statement-breakpoint

-- A booking that was confirmed and then cancelled still has a confirmation
-- time.
--
-- Phase 13 wrote this as an equivalence — `state is one of the live confirmed
-- states` **iff** `confirmed_at is not null` — which was right for every path
-- that phase could reach and wrong for the first one Phase 14 reaches: a
-- guest cancelling a *paid* booking. The moment `state` left the set, the
-- equivalence demanded that the confirmation had never happened, and the
-- database refused a transition the requirements require (`PAY-DEC-007`).
--
-- The rule the requirements actually state is an implication: a booking in one
-- of those states carries the instant it was confirmed at. A terminal booking
-- keeps it, because it is a fact about the past and doc 11 §9 does not erase
-- those.
ALTER TABLE platform.booking
  DROP CONSTRAINT booking_confirmed_has_time;
--> statement-breakpoint
ALTER TABLE platform.booking
  ADD CONSTRAINT booking_confirmed_has_time
    CHECK (state <> ALL (ARRAY['CONFIRMED'::text, 'CHECKED_IN'::text, 'COMPLETED'::text])
           OR confirmed_at IS NOT NULL);
--> statement-breakpoint

-- The Phase 13 guard, extended: the policy snapshot joins the price snapshot as
-- something the database will not let move once it exists.
CREATE OR REPLACE FUNCTION platform.booking_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_terminal constant text[] := ARRAY['EXPIRED', 'CANCELLED_GUEST', 'CANCELLED_HOTEL',
                                      'NO_SHOW', 'COMPLETED'];
BEGIN
  IF NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.booking_ref IS DISTINCT FROM OLD.booking_ref
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.booker_account_id IS DISTINCT FROM OLD.booker_account_id
     OR NEW.check_in_date IS DISTINCT FROM OLD.check_in_date
     OR NEW.check_out_date IS DISTINCT FROM OLD.check_out_date
     OR NEW.night_count IS DISTINCT FROM OLD.night_count
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a booking''s identity, window and booker are immutable (BK-DEC-012); '
                    'a change is a cancellation and a new booking'
      USING ERRCODE = '42501';
  END IF;
  -- `BK-DEC-009`: the ten minutes are the server's, once.
  IF NEW.hold_expires_at IS DISTINCT FROM OLD.hold_expires_at THEN
    RAISE EXCEPTION 'a payment hold is never extended (BK-DEC-009)' USING ERRCODE = '42501';
  END IF;
  -- doc 09 §10: a paid booking is never repriced.
  IF OLD.rate_snapshot_id IS NOT NULL
     AND (NEW.rate_snapshot_id IS DISTINCT FROM OLD.rate_snapshot_id
          OR NEW.unit_rate_mnt IS DISTINCT FROM OLD.unit_rate_mnt
          OR NEW.total_amount_mnt IS DISTINCT FROM OLD.total_amount_mnt
          OR NEW.pricing_config_version IS DISTINCT FROM OLD.pricing_config_version) THEN
    RAISE EXCEPTION 'a confirmed price is a snapshot and is never re-resolved (doc 09 §10)'
      USING ERRCODE = '42501';
  END IF;
  -- doc 11 §5: and neither is the cancellation policy it was sold under. A
  -- deadline that could be moved after the fact is not a deadline.
  IF OLD.free_cancellation_until IS NOT NULL
     AND (NEW.free_cancellation_until IS DISTINCT FROM OLD.free_cancellation_until
          OR NEW.cancellation_policy_version IS DISTINCT FROM OLD.cancellation_policy_version) THEN
    RAISE EXCEPTION 'the cancellation policy shown before payment is a snapshot (doc 11 §5)'
      USING ERRCODE = '42501';
  END IF;
  -- `PAY-DEC-006`: a terminal booking is never reopened, by a late payment or
  -- by anything else. Its money axes may still move — a refund obligation is
  -- raised and settled after the booking has ended.
  IF OLD.state = ANY (v_terminal) AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a terminal booking is never reopened (PAY-DEC-006)' USING ERRCODE = '22023';
  END IF;
  IF OLD.payment_state = 'PAID'::text AND NEW.payment_state IS DISTINCT FROM OLD.payment_state THEN
    RAISE EXCEPTION 'a captured payment is never unpaid' USING ERRCODE = '22023';
  END IF;
  IF OLD.hold_state <> 'ACTIVE'::text AND NEW.hold_state IS DISTINCT FROM OLD.hold_state THEN
    RAISE EXCEPTION 'a settled hold is never reopened' USING ERRCODE = '22023';
  END IF;
  -- doc 11 §9: the refund axis is its own, and only a verified provider result
  -- moves it to `REFUNDED`. Once there it stays there — a later failure is a new
  -- obligation, not an un-refunding of money the guest already has back.
  IF OLD.refund_state = 'REFUNDED'::text AND NEW.refund_state IS DISTINCT FROM OLD.refund_state THEN
    RAISE EXCEPTION 'a completed refund is never withdrawn (doc 11 §5)' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- =====================================================================
-- The contract that fixes a hotel's commission
-- =====================================================================

-- `PAY-DEC-001` / `BK-DEC-008`: every hotel that sells online has an explicit,
-- negotiated rate. There is no platform default and no fallback — a hotel with
-- no `ACTIVE` contract cannot take an online booking payment, which is the whole
-- point of the decision and is why `commission_rate_bps` has no DEFAULT.
--
-- doc 18 names no permission for administering this, and a role that the
-- requirements do not grant is a role this migration will not invent: the API
-- and the worker hold SELECT and nothing else. A contract is established
-- out-of-band by the same restricted principal that runs migrations, exactly as
-- a signed commercial agreement reaches the platform in the first place.
CREATE TABLE platform.hotel_commission_contract (
  contract_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                    uuid NOT NULL,
  contract_version            integer NOT NULL,
  -- doc 11 §3: the rate differs by counterparty and by negotiated tariff.
  party_type                  text NOT NULL,
  -- Integer basis points, so no rate ever carries a binary fraction into money.
  commission_rate_bps         integer NOT NULL,
  -- The cancellation policy this contract sells under, snapshotted onto every
  -- booking held while the contract is active (doc 11 §5).
  cancellation_policy_version integer NOT NULL,
  effective_from              timestamptz NOT NULL,
  -- Exclusive. NULL is an open-ended contract.
  effective_to                timestamptz,
  state                       text NOT NULL DEFAULT 'ACTIVE',
  created_at                  timestamptz NOT NULL DEFAULT now(),
  revision                    integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_commission_contract_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_commission_contract_identity_uq UNIQUE (hotel_id, contract_id),
  CONSTRAINT hotel_commission_contract_version_uq UNIQUE (hotel_id, contract_version),
  CONSTRAINT hotel_commission_contract_party_known
    CHECK (party_type = ANY (ARRAY['INDIVIDUAL'::text, 'ORGANISATION'::text,
                                   'NEGOTIATED'::text])),
  CONSTRAINT hotel_commission_contract_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'SUPERSEDED'::text, 'TERMINATED'::text])),
  CONSTRAINT hotel_commission_contract_rate_bounded
    CHECK (commission_rate_bps >= 0 AND commission_rate_bps <= 10000),
  CONSTRAINT hotel_commission_contract_version_positive
    CHECK (contract_version > 0 AND cancellation_policy_version > 0),
  CONSTRAINT hotel_commission_contract_window
    CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT hotel_commission_contract_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
-- One active contract per hotel: "the hotel's valid contract" is a single row,
-- not a query that has to pick between candidates.
CREATE UNIQUE INDEX hotel_commission_contract_active_uq
  ON platform.hotel_commission_contract (hotel_id)
  WHERE state = 'ACTIVE'::text;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.hotel_commission_contract_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.commission_rate_bps IS DISTINCT FROM OLD.commission_rate_bps
     OR NEW.cancellation_policy_version IS DISTINCT FROM OLD.cancellation_policy_version
     OR NEW.party_type IS DISTINCT FROM OLD.party_type
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a commission rate is amended by a new contract version, never in place '
                    '(PAY-DEC-001)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'ACTIVE'::text AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a closed contract is never reopened' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hotel_commission_contract_update_guard
  BEFORE UPDATE ON platform.hotel_commission_contract
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_commission_contract_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_commission_contract_no_delete
  BEFORE DELETE ON platform.hotel_commission_contract
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
ALTER TABLE platform.hotel_commission_contract ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_commission_contract FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_commission_contract
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- What the hotel is owed for one booking
-- =====================================================================

-- One row per booking that was actually paid for. It carries the contract
-- snapshot the money was settled under and the running totals, and every
-- formula doc 11 §3 states is a CHECK on this row rather than a convention in
-- application code:
--
--   retained      = gross − refunded                    (commission base)
--   commission    = ROUND_HALF_UP(retained × rate_bps)  (`PAY-DEC-008`, once)
--   hotel payable = retained − commission
--
-- The provider fee is stored here and appears in none of them (`PAY-DEC-004`,
-- `BK-DEC-011`). Full refund and hotel-caused cancellation need no special case
-- in the formula: `refunded = gross` makes the base `0`, and a base of `0`
-- makes the commission `0`.
CREATE TABLE platform.booking_payable (
  payable_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id            uuid NOT NULL,
  booking_id          uuid NOT NULL,
  -- The contract as it stood when the payment was confirmed. A later contract
  -- version never reprices a booking that has already been settled (doc 11 §3).
  contract_id         uuid NOT NULL,
  contract_version    integer NOT NULL,
  commission_rate_bps integer NOT NULL,
  gross_paid_mnt      bigint NOT NULL,
  refunded_mnt        bigint NOT NULL DEFAULT 0,
  retained_mnt        bigint NOT NULL,
  commission_mnt      bigint NOT NULL,
  hotel_payable_mnt   bigint NOT NULL,
  -- The platform's own cost. Never a term of the payout above.
  provider_fee_mnt    bigint NOT NULL DEFAULT 0,
  -- What has actually reached the hotel. A post-payout refund makes the payable
  -- smaller than this, and the difference is the negative adjustment
  -- `PAY-DEC-009` deducts from the next batch.
  paid_out_mnt        bigint NOT NULL DEFAULT 0,
  payout_state        text NOT NULL DEFAULT 'NOT_ELIGIBLE',
  -- When this payable first became payable at all. Written once: a retry, a
  -- failed transfer or a later adjustment does not change when the hotel earned
  -- the money.
  eligible_at         timestamptz,
  -- The hotel-local day `D` whose batch — `D+1 12:00 Asia/Ulaanbaatar` — this
  -- amount belongs to. It moves when a *new* amount falls due, which is how a
  -- post-payout adjustment reaches the next batch rather than a past one.
  eligible_local_date date,
  hold_reason         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT booking_payable_booking_fkey FOREIGN KEY (hotel_id, booking_id)
    REFERENCES platform.booking (hotel_id, booking_id) ON DELETE RESTRICT,
  CONSTRAINT booking_payable_contract_fkey FOREIGN KEY (hotel_id, contract_id)
    REFERENCES platform.hotel_commission_contract (hotel_id, contract_id) ON DELETE RESTRICT,
  -- One booking, one payable. A second capture is a refund obligation, never a
  -- second thing to pay the hotel for (`PAY-DEC-006`).
  CONSTRAINT booking_payable_booking_uq UNIQUE (booking_id),
  CONSTRAINT booking_payable_identity_uq UNIQUE (hotel_id, payable_id),
  CONSTRAINT booking_payable_state_known
    CHECK (payout_state = ANY (ARRAY['NOT_ELIGIBLE'::text, 'ELIGIBLE'::text, 'HELD'::text,
                                     'BATCHED'::text, 'PAID'::text, 'FAILED'::text,
                                     'ADJUSTMENT_DUE'::text])),
  CONSTRAINT booking_payable_rate_bounded
    CHECK (commission_rate_bps >= 0 AND commission_rate_bps <= 10000),
  CONSTRAINT booking_payable_amounts_non_negative
    CHECK (gross_paid_mnt >= 0 AND refunded_mnt >= 0 AND provider_fee_mnt >= 0
           AND paid_out_mnt >= 0),
  CONSTRAINT booking_payable_refund_within_capture CHECK (refunded_mnt <= gross_paid_mnt),
  -- doc 11 §3: the commission base is what the guest was actually charged, net
  -- of what came back to them.
  CONSTRAINT booking_payable_retained_base
    CHECK (retained_mnt = gross_paid_mnt - refunded_mnt),
  -- `PAY-DEC-008`: `ROUND_HALF_UP`, exactly once, in integer arithmetic. On
  -- non-negative bigints `(base * bps + 5000) / 10000` *is* half-up, and the
  -- database refuses any row that rounded some other way.
  CONSTRAINT booking_payable_commission_rounded
    CHECK (commission_mnt = (retained_mnt * commission_rate_bps + 5000) / 10000),
  CONSTRAINT booking_payable_hotel_share
    CHECK (hotel_payable_mnt = retained_mnt - commission_mnt),
  CONSTRAINT booking_payable_eligible_shape
    CHECK ((eligible_at IS NULL) = (eligible_local_date IS NULL)),
  CONSTRAINT booking_payable_eligible_when_due
    CHECK (payout_state <> 'ELIGIBLE'::text
           OR (eligible_at IS NOT NULL AND hotel_payable_mnt > paid_out_mnt)),
  -- `PAY-DEC-009`: a negative adjustment is exactly the case where the hotel has
  -- already been paid more than the booking finally earned.
  CONSTRAINT booking_payable_adjustment_when_overpaid
    CHECK (payout_state <> 'ADJUSTMENT_DUE'::text OR hotel_payable_mnt < paid_out_mnt),
  CONSTRAINT booking_payable_hold_reason_bounded
    CHECK (hold_reason IS NULL OR length(hold_reason) BETWEEN 1 AND 200),
  CONSTRAINT booking_payable_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX booking_payable_due_idx
  ON platform.booking_payable (payout_state, eligible_local_date)
  WHERE payout_state = ANY (ARRAY['ELIGIBLE'::text, 'ADJUSTMENT_DUE'::text]);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.booking_payable_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.payable_id IS DISTINCT FROM OLD.payable_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payable''s identity is immutable' USING ERRCODE = '42501';
  END IF;
  -- doc 11 §3: the rate that was snapshotted is the rate that settles. A
  -- renegotiated contract applies to bookings paid after it, and to no other.
  IF NEW.contract_id IS DISTINCT FROM OLD.contract_id
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.commission_rate_bps IS DISTINCT FROM OLD.commission_rate_bps
     OR NEW.gross_paid_mnt IS DISTINCT FROM OLD.gross_paid_mnt THEN
    RAISE EXCEPTION 'the commission snapshot and the captured amount are fixed at confirmation '
                    '(PAY-DEC-008)'
      USING ERRCODE = '42501';
  END IF;
  -- Money already refunded, already invoiced as a fee and already paid out only
  -- ever grows. Anything else would be an edit of a settled financial fact.
  IF NEW.refunded_mnt < OLD.refunded_mnt THEN
    RAISE EXCEPTION 'a refund is never un-refunded (doc 11 §9)' USING ERRCODE = '22023';
  END IF;
  IF NEW.provider_fee_mnt < OLD.provider_fee_mnt THEN
    RAISE EXCEPTION 'a provider fee is never reduced in place (BK-DEC-011)' USING ERRCODE = '22023';
  END IF;
  IF NEW.eligible_at IS DISTINCT FROM OLD.eligible_at AND OLD.eligible_at IS NOT NULL THEN
    RAISE EXCEPTION 'the day a payable became eligible is written once (PAY-DEC-009)'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER booking_payable_update_guard
  BEFORE UPDATE ON platform.booking_payable
  FOR EACH ROW EXECUTE FUNCTION platform.booking_payable_guard();
--> statement-breakpoint
CREATE TRIGGER booking_payable_no_delete
  BEFORE DELETE ON platform.booking_payable
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
ALTER TABLE platform.booking_payable ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.booking_payable FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.booking_payable
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- The immutable money ledger
-- =====================================================================

-- doc 11 §9: payment, commission, hotel payable, provider fee, refund,
-- adjustment and payout are each their own event, and a correction is another
-- event rather than an edit of the first. `source_ref` is what makes a repeated
-- delivery — a duplicated callback, a retried job, a replayed batch — post once:
-- the unique index refuses the second write of the same cause.
CREATE TABLE platform.booking_ledger_event (
  ledger_event_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id            uuid NOT NULL,
  booking_id          uuid NOT NULL,
  payable_id          uuid,
  event_type          text NOT NULL,
  -- Signed: a reversal is the exact negative of what it reverses.
  amount_mnt          bigint NOT NULL,
  currency            text NOT NULL DEFAULT 'MNT',
  provider            text,
  provider_payment_id text,
  provider_refund_id  text,
  bank_reference      text,
  -- The cause, unique per event type. Two deliveries of one provider event, or
  -- two runs of one batch, name the same cause and post once.
  source_ref          text NOT NULL,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_ledger_event_booking_fkey FOREIGN KEY (hotel_id, booking_id)
    REFERENCES platform.booking (hotel_id, booking_id) ON DELETE RESTRICT,
  CONSTRAINT booking_ledger_event_payable_fkey FOREIGN KEY (hotel_id, payable_id)
    REFERENCES platform.booking_payable (hotel_id, payable_id) ON DELETE RESTRICT,
  CONSTRAINT booking_ledger_event_type_known
    CHECK (event_type = ANY (ARRAY['PAYMENT'::text, 'COMMISSION'::text, 'HOTEL_PAYABLE'::text,
                                   'PROVIDER_FEE'::text, 'REFUND'::text, 'ADJUSTMENT'::text,
                                   'PAYOUT'::text])),
  CONSTRAINT booking_ledger_event_currency_known CHECK (currency = 'MNT'::text),
  CONSTRAINT booking_ledger_event_provider_known
    CHECK (provider IS NULL OR provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text])),
  CONSTRAINT booking_ledger_event_source_bounded
    CHECK (length(source_ref) BETWEEN 1 AND 200),
  CONSTRAINT booking_ledger_event_reference_bounded
    CHECK (bank_reference IS NULL OR length(bank_reference) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX booking_ledger_event_cause_uq
  ON platform.booking_ledger_event (event_type, source_ref);
--> statement-breakpoint
CREATE INDEX booking_ledger_event_booking_idx
  ON platform.booking_ledger_event (booking_id, occurred_at);
--> statement-breakpoint
CREATE INDEX booking_ledger_event_payable_idx
  ON platform.booking_ledger_event (payable_id, event_type);
--> statement-breakpoint
CREATE TRIGGER booking_ledger_event_append_only
  BEFORE UPDATE OR DELETE ON platform.booking_ledger_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
ALTER TABLE platform.booking_ledger_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.booking_ledger_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.booking_ledger_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- The refund axis
-- =====================================================================

-- doc 11 §5: asking to cancel is not being refunded. The booking ends
-- immediately and releases its inventory; the money comes back on its own axis,
-- and only a verified provider result moves it to `REFUNDED` — which is why doc
-- 18 §3.3 grants no role the power to mark one by hand.
--
-- `payable_id` is what separates the two kinds of refund. A cancellation or
-- no-show balance is money coming back *out of the captured payment*, so it
-- reduces the payable's base. A late or duplicate capture is money that never
-- entered the payable at all (`PAY-DEC-006`), so its refund names no payable and
-- reduces nothing: the hotel is owed exactly what the first valid payment
-- earned, whatever the provider charged twice.
CREATE TABLE platform.booking_refund (
  refund_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id            uuid NOT NULL,
  booking_id          uuid NOT NULL,
  payable_id          uuid,
  reason              text NOT NULL,
  amount_mnt          bigint NOT NULL,
  state               text NOT NULL DEFAULT 'REQUIRED',
  provider            text NOT NULL,
  provider_payment_id text,
  provider_refund_id  text,
  failure_code        text,
  -- The obligation that caused it. A repeated request or a duplicated callback
  -- names the same cause and creates nothing new.
  source_ref          text NOT NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz,
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT booking_refund_booking_fkey FOREIGN KEY (hotel_id, booking_id)
    REFERENCES platform.booking (hotel_id, booking_id) ON DELETE RESTRICT,
  CONSTRAINT booking_refund_payable_fkey FOREIGN KEY (hotel_id, payable_id)
    REFERENCES platform.booking_payable (hotel_id, payable_id) ON DELETE RESTRICT,
  CONSTRAINT booking_refund_cause_uq UNIQUE (booking_id, source_ref),
  CONSTRAINT booking_refund_reason_known
    CHECK (reason = ANY (ARRAY['GUEST_CANCELLATION'::text, 'LATE_CANCELLATION_BALANCE'::text,
                               'NO_SHOW_BALANCE'::text, 'HOTEL_CANCELLATION'::text,
                               'LATE_PAYMENT_AFTER_HOLD'::text, 'DUPLICATE_CAPTURE'::text])),
  CONSTRAINT booking_refund_state_known
    CHECK (state = ANY (ARRAY['REQUIRED'::text, 'PENDING'::text, 'REFUNDED'::text,
                              'FAILED'::text])),
  CONSTRAINT booking_refund_provider_known
    CHECK (provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text])),
  CONSTRAINT booking_refund_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT booking_refund_settled_shape
    CHECK ((state = ANY (ARRAY['REFUNDED'::text, 'FAILED'::text])) = (settled_at IS NOT NULL)),
  -- A completed refund names the provider's own record of it.
  CONSTRAINT booking_refund_completed_has_reference
    CHECK (state <> 'REFUNDED'::text OR provider_refund_id IS NOT NULL),
  CONSTRAINT booking_refund_failure_shape
    CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  CONSTRAINT booking_refund_source_bounded CHECK (length(source_ref) BETWEEN 1 AND 200),
  CONSTRAINT booking_refund_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
-- One provider refund is one row, however many times it is delivered.
CREATE UNIQUE INDEX booking_refund_provider_refund_uq
  ON platform.booking_refund (provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX booking_refund_open_idx
  ON platform.booking_refund (state, requested_at)
  WHERE state = ANY (ARRAY['REQUIRED'::text, 'PENDING'::text]);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.booking_refund_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.refund_id IS DISTINCT FROM OLD.refund_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.payable_id IS DISTINCT FROM OLD.payable_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.source_ref IS DISTINCT FROM OLD.source_ref
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'a refund obligation''s cause and amount are fixed when it is raised '
                    '(doc 11 §9)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'REFUNDED'::text AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a completed refund is never withdrawn (doc 11 §5)' USING ERRCODE = '22023';
  END IF;
  IF OLD.provider_refund_id IS NOT NULL
     AND NEW.provider_refund_id IS DISTINCT FROM OLD.provider_refund_id THEN
    RAISE EXCEPTION 'a provider refund reference is written once' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER booking_refund_update_guard
  BEFORE UPDATE ON platform.booking_refund
  FOR EACH ROW EXECUTE FUNCTION platform.booking_refund_guard();
--> statement-breakpoint
CREATE TRIGGER booking_refund_no_delete
  BEFORE DELETE ON platform.booking_refund
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
ALTER TABLE platform.booking_refund ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.booking_refund FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.booking_refund
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- The `D+1 12:00` payout batch
-- =====================================================================

-- `PAY-DEC-009`: what became eligible on the hotel-local day `D` is paid in the
-- batch of `D+1 12:00 Asia/Ulaanbaatar`. A failed payout is not overwritten —
-- `attempt_no` makes the retry a new row, so the failure stays on the record
-- and the bank holiday that delayed it changed nothing about eligibility.
--
-- Every batch reconciles: the six totals are the sum of its `PAYABLE` items,
-- plus the negative `ADJUSTMENT` items, and the CHECKs below are what make
-- "the batch balances" a property of the row rather than of a report.
CREATE TABLE platform.payout_batch (
  batch_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id          uuid NOT NULL,
  -- The hotel-local day the batch runs: `D + 1`.
  batch_local_date  date NOT NULL,
  attempt_no        integer NOT NULL DEFAULT 1,
  scheduled_at      timestamptz NOT NULL,
  state             text NOT NULL DEFAULT 'OPEN',
  gross_paid_mnt    bigint NOT NULL DEFAULT 0,
  refunded_mnt      bigint NOT NULL DEFAULT 0,
  retained_mnt      bigint NOT NULL DEFAULT 0,
  commission_mnt    bigint NOT NULL DEFAULT 0,
  -- Never positive: an adjustment only ever deducts (`PAY-DEC-009`).
  adjustment_mnt    bigint NOT NULL DEFAULT 0,
  hotel_payable_mnt bigint NOT NULL DEFAULT 0,
  bank_reference    text,
  failure_code      text,
  settled_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revision          integer NOT NULL DEFAULT 0,
  CONSTRAINT payout_batch_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT payout_batch_identity_uq UNIQUE (hotel_id, batch_id),
  CONSTRAINT payout_batch_attempt_uq UNIQUE (hotel_id, batch_local_date, attempt_no),
  CONSTRAINT payout_batch_state_known
    CHECK (state = ANY (ARRAY['OPEN'::text, 'SUBMITTED'::text, 'PAID'::text, 'FAILED'::text])),
  CONSTRAINT payout_batch_attempt_positive CHECK (attempt_no > 0),
  CONSTRAINT payout_batch_amounts_non_negative
    CHECK (gross_paid_mnt >= 0 AND refunded_mnt >= 0 AND retained_mnt >= 0
           AND commission_mnt >= 0),
  CONSTRAINT payout_batch_adjustment_never_adds CHECK (adjustment_mnt <= 0),
  CONSTRAINT payout_batch_retained_base CHECK (retained_mnt = gross_paid_mnt - refunded_mnt),
  CONSTRAINT payout_batch_reconciles
    CHECK (hotel_payable_mnt = retained_mnt - commission_mnt + adjustment_mnt),
  -- doc 11 §8: a paid batch is tied to the bank's own record of the transfer.
  CONSTRAINT payout_batch_paid_has_reference
    CHECK (state <> 'PAID'::text OR bank_reference IS NOT NULL),
  CONSTRAINT payout_batch_settled_shape
    CHECK ((state = ANY (ARRAY['PAID'::text, 'FAILED'::text])) = (settled_at IS NOT NULL)),
  CONSTRAINT payout_batch_reference_bounded
    CHECK (bank_reference IS NULL OR length(bank_reference) BETWEEN 1 AND 120),
  CONSTRAINT payout_batch_failure_bounded
    CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  CONSTRAINT payout_batch_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX payout_batch_open_idx ON platform.payout_batch (hotel_id, state, scheduled_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.payout_batch_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.batch_local_date IS DISTINCT FROM OLD.batch_local_date
     OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
     OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payout attempt''s identity and schedule are immutable (PAY-DEC-009)'
      USING ERRCODE = '42501';
  END IF;
  -- Once it has left for the bank, what it claims to pay is fixed. A different
  -- amount is a different attempt.
  IF OLD.state <> 'OPEN'::text
     AND (NEW.gross_paid_mnt IS DISTINCT FROM OLD.gross_paid_mnt
          OR NEW.refunded_mnt IS DISTINCT FROM OLD.refunded_mnt
          OR NEW.retained_mnt IS DISTINCT FROM OLD.retained_mnt
          OR NEW.commission_mnt IS DISTINCT FROM OLD.commission_mnt
          OR NEW.adjustment_mnt IS DISTINCT FROM OLD.adjustment_mnt
          OR NEW.hotel_payable_mnt IS DISTINCT FROM OLD.hotel_payable_mnt) THEN
    RAISE EXCEPTION 'a submitted payout batch is never re-totalled (doc 11 §8)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state = ANY (ARRAY['PAID'::text, 'FAILED'::text])
     AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a settled payout attempt is never reopened; a retry is a new attempt '
                    '(PAY-DEC-009)'
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
CREATE TRIGGER payout_batch_update_guard
  BEFORE UPDATE ON platform.payout_batch
  FOR EACH ROW EXECUTE FUNCTION platform.payout_batch_guard();
--> statement-breakpoint
CREATE TRIGGER payout_batch_no_delete
  BEFORE DELETE ON platform.payout_batch
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
ALTER TABLE platform.payout_batch ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.payout_batch FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.payout_batch
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- What a batch is made of. `settled` is set when the batch is paid, and the
-- partial unique index below is doc 11 §8's "one booking payable enters exactly
-- one successful payout" — enforced by the database, so a retry that batched the
-- same payable twice cannot both succeed.
CREATE TABLE platform.payout_batch_item (
  item_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id   uuid NOT NULL,
  batch_id   uuid NOT NULL,
  payable_id uuid NOT NULL,
  kind       text NOT NULL,
  amount_mnt bigint NOT NULL,
  settled    boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payout_batch_item_batch_fkey FOREIGN KEY (hotel_id, batch_id)
    REFERENCES platform.payout_batch (hotel_id, batch_id) ON DELETE RESTRICT,
  CONSTRAINT payout_batch_item_payable_fkey FOREIGN KEY (hotel_id, payable_id)
    REFERENCES platform.booking_payable (hotel_id, payable_id) ON DELETE RESTRICT,
  CONSTRAINT payout_batch_item_uq UNIQUE (batch_id, payable_id, kind),
  CONSTRAINT payout_batch_item_kind_known
    CHECK (kind = ANY (ARRAY['PAYABLE'::text, 'ADJUSTMENT'::text])),
  CONSTRAINT payout_batch_item_payable_positive
    CHECK (kind <> 'PAYABLE'::text OR amount_mnt > 0),
  CONSTRAINT payout_batch_item_adjustment_negative
    CHECK (kind <> 'ADJUSTMENT'::text OR amount_mnt < 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX payout_batch_item_settled_payable_uq
  ON platform.payout_batch_item (payable_id)
  WHERE settled AND kind = 'PAYABLE'::text;
--> statement-breakpoint
CREATE INDEX payout_batch_item_batch_idx ON platform.payout_batch_item (batch_id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.payout_batch_item_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.item_id IS DISTINCT FROM OLD.item_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.payable_id IS DISTINCT FROM OLD.payable_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payout line is immutable; only its settlement is recorded'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.settled AND NOT NEW.settled THEN
    RAISE EXCEPTION 'a settled payout line is never unsettled (doc 11 §9)' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payout_batch_item_update_guard
  BEFORE UPDATE ON platform.payout_batch_item
  FOR EACH ROW EXECUTE FUNCTION platform.payout_batch_item_guard();
--> statement-breakpoint
CREATE TRIGGER payout_batch_item_no_delete
  BEFORE DELETE ON platform.payout_batch_item
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
ALTER TABLE platform.payout_batch_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.payout_batch_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.payout_batch_item
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Grants
-- =====================================================================

-- The commission contract is read by both and written by neither. doc 18 grants
-- no role the power to set a hotel's rate, so neither login principal is given
-- one: the contract arrives the way the agreement it records does.
GRANT SELECT                 ON platform.hotel_commission_contract TO prsystem_api, prsystem_worker;
--> statement-breakpoint
-- The API opens a payable when a payment confirms and adjusts it as the booking
-- ends. The worker settles refunds and payouts against payables that already
-- exist, so it never creates one.
GRANT SELECT, INSERT, UPDATE ON platform.booking_payable       TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.booking_payable       TO prsystem_worker;
--> statement-breakpoint
-- Both post to the ledger and neither can amend it: the append-only trigger
-- refuses an UPDATE whatever the grant says, and no principal holds one anyway.
GRANT SELECT, INSERT         ON platform.booking_ledger_event  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
-- The API raises a refund obligation; the worker executes it against the
-- provider and records what the provider answered.
GRANT SELECT, INSERT, UPDATE ON platform.booking_refund        TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.booking_refund        TO prsystem_worker;
--> statement-breakpoint
-- The payout batch is a job. The API reads it for reconciliation and writes
-- none of it.
GRANT SELECT                 ON platform.payout_batch          TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.payout_batch          TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT                 ON platform.payout_batch_item     TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.payout_batch_item     TO prsystem_worker;
--> statement-breakpoint

-- =====================================================================
-- Job dispatch across tenants
-- =====================================================================

-- Both sweeps have the same shape as Phase 13's expiry sweep: a job has to find
-- work across every hotel before it can do any of it, and it has no tenant of
-- its own. Each answers identifiers and nothing else, through a `SECURITY
-- DEFINER` function owned by the login-less resolver role; the settling itself
-- happens in the hotel's own scope, on the row's own lock.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform.due_payout_batches(
  p_limit integer,
  p_now   timestamptz DEFAULT NULL
) RETURNS TABLE (hotel_id uuid, batch_local_date date)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.hotel_id, (p.eligible_local_date + 1) AS batch_local_date
    FROM platform.booking_payable p
   WHERE p.payout_state = ANY (ARRAY['ELIGIBLE'::text, 'ADJUSTMENT_DUE'::text])
     AND p.eligible_local_date IS NOT NULL
     -- `PAY-DEC-009`: what became eligible on `D` is paid at `D+1 12:00`
     -- Asia/Ulaanbaatar. The instant is derived from the hotel-local date at
     -- the point of use and never stored as one.
     AND (((p.eligible_local_date + 1)::timestamp + interval '12 hours')
            AT TIME ZONE 'Asia/Ulaanbaatar') <= coalesce(p_now, pg_catalog.now())
   GROUP BY p.hotel_id, (p.eligible_local_date + 1)
   ORDER BY (p.eligible_local_date + 1), p.hotel_id
   LIMIT p_limit
$$;
--> statement-breakpoint
ALTER FUNCTION platform.due_payout_batches(integer, timestamptz)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform.open_booking_refunds(
  p_limit integer
) RETURNS TABLE (refund_id uuid, hotel_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT r.refund_id, r.hotel_id
    FROM platform.booking_refund r
   WHERE r.state = ANY (ARRAY['REQUIRED'::text, 'PENDING'::text])
   ORDER BY r.requested_at
   LIMIT p_limit
$$;
--> statement-breakpoint
ALTER FUNCTION platform.open_booking_refunds(integer) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  platform.due_payout_batches(integer, timestamptz),
  platform.open_booking_refunds(integer)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.due_payout_batches(integer, timestamptz)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.open_booking_refunds(integer)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
--> statement-breakpoint

-- RLS still applies to the function's owner, so each resolver gets exactly the
-- narrow read it needs: work that is waiting, and nothing else. A payable that
-- is not due and a refund that has settled are invisible to them.
GRANT SELECT ON platform.booking_payable, platform.booking_refund
  TO prsystem_maintenance_fn;
--> statement-breakpoint
CREATE POLICY payout_dispatch_read ON platform.booking_payable
  FOR SELECT TO prsystem_maintenance_fn
  USING (payout_state = ANY (ARRAY['ELIGIBLE'::text, 'ADJUSTMENT_DUE'::text]));
--> statement-breakpoint
CREATE POLICY refund_dispatch_read ON platform.booking_refund
  FOR SELECT TO prsystem_maintenance_fn
  USING (state = ANY (ARRAY['REQUIRED'::text, 'PENDING'::text]));
--> statement-breakpoint

-- =====================================================================
-- The captured transaction behind an attempt
-- =====================================================================

-- doc 11 §4.10: one provider payment or transaction id belongs to exactly one
-- payment attempt. Phase 13 stored the invoice; the *payment* is what a refund
-- is issued against and what a duplicate capture repeats, so it is recorded
-- here and made unique.
ALTER TABLE platform.booking_payment_attempt
  ADD COLUMN provider_payment_id text;
--> statement-breakpoint
CREATE UNIQUE INDEX booking_payment_attempt_payment_uq
  ON platform.booking_payment_attempt (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
--> statement-breakpoint
ALTER TABLE platform.booking_payment_attempt
  ADD CONSTRAINT booking_payment_attempt_payment_shape
    CHECK (provider_payment_id IS NULL OR length(provider_payment_id) BETWEEN 1 AND 200);
--> statement-breakpoint

-- The Phase 13 attempt guard, extended: a captured transaction id is written
-- once and never repointed at another payment.
CREATE OR REPLACE FUNCTION platform.booking_payment_attempt_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.booking_id IS DISTINCT FROM OLD.booking_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payment attempt''s identity, provider and amount are immutable; '
                    'a different one is a new attempt (doc 09 §8)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.provider_invoice_id IS NOT NULL
     AND NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id THEN
    RAISE EXCEPTION 'a provider invoice reference is written once' USING ERRCODE = '42501';
  END IF;
  IF OLD.provider_payment_id IS NOT NULL
     AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
    RAISE EXCEPTION 'a captured transaction is never repointed (doc 11 §4.10)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'ACTIVE'::text AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a settled payment attempt is never reopened' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- A provider callback names an invoice and no tenant. The hotel a callback
-- belongs to is the server's to resolve, exactly as the hotel a category
-- belongs to is: a `SECURITY DEFINER` function owned by the login-less resolver
-- role, answering three identifiers and nothing else.
--
-- It deliberately finds an attempt in *any* state. `PAY-DEC-006` is precisely
-- about the callbacks that arrive after an attempt has expired or been
-- superseded, and a resolver that could not see those would make a late capture
-- unrecognisable rather than refundable.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform.booking_attempt_of_invoice(
  p_provider   text,
  p_invoice_id text
) RETURNS TABLE (attempt_id uuid, hotel_id uuid, booking_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.attempt_id, a.hotel_id, a.booking_id
    FROM platform.booking_payment_attempt a
   WHERE a.provider = p_provider
     AND a.provider_invoice_id = p_invoice_id
$$;
--> statement-breakpoint
ALTER FUNCTION platform.booking_attempt_of_invoice(text, text)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.booking_attempt_of_invoice(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.booking_attempt_of_invoice(text, text) TO prsystem_api;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT ON platform.booking_payment_attempt TO prsystem_maintenance_fn;
--> statement-breakpoint
CREATE POLICY callback_dispatch_read ON platform.booking_payment_attempt
  FOR SELECT TO prsystem_maintenance_fn
  USING (provider_invoice_id IS NOT NULL);
--> statement-breakpoint

-- The worker reads the hotel's timezone, and only that.
--
-- `PAY-DEC-009` puts a payout batch at `D+1 12:00` in the *hotel's* zone, and
-- files eligibility under the hotel's own calendar day. The job cannot derive
-- either without the hotel row, and RLS still confines it to the tenant whose
-- payable it is settling — this widens what the worker may read to exactly the
-- hotel it is already working in.
GRANT SELECT ON platform.hotel TO prsystem_worker;
--> statement-breakpoint
