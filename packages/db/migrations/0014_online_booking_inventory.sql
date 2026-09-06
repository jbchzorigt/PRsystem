-- Online booking and the inventory hold that makes it safe to sell.
--
-- Five structural rules run through this migration.
--
-- **A booking holds a category unit, never a room.** `BK-DEC-013`: a hold and a
-- confirmed booking occupy one capacity unit of a `room_category`, and the
-- physical room is assigned by Reception at check-in. Availability is the
-- eligible `ACTIVE` room count minus overlapping active holds, confirmed
-- bookings and active stays.
--
-- **Overbooking is refused by the database, not by a query.** A count computed
-- and then acted on is a race with a name. Occupancy is therefore a row per
-- category per night, carrying the capacity that night and the units taken,
-- with `CHECK (units_held <= units_capacity)`. Two guests racing the last unit
-- serialize on that row and the loser is refused by a constraint, not by a
-- re-read.
--
-- **One clock, one hold.** `BK-DEC-009` / `PAY-DEC-002`: the hold lives ten
-- minutes from the moment the server created it, and no invoice or session may
-- outlive it. `hold_expires_at` is written once and never moved.
--
-- **Expiry and the callback compete on one row.** `PAY-DEC-006`: both take the
-- booking `FOR UPDATE`. Whichever arrives second sees a settled row. A payment
-- that lands after expiry does not reopen the booking and does not re-occupy
-- inventory; it raises a full refund obligation instead. A second capture of an
-- already-paid booking raises one too, and a captured transaction reaches the
-- ledger exactly once.
--
-- **Money is not settled here.** Phase 13 records the payment *attempt*
-- lifecycle and the refund *obligation*. Capture, refund execution, commission
-- and settlement belong to Phase 14 and are deliberately absent.
--
-- docs 09 (`BK-DEC-009`, `-012`, `-013`, `-014`), 11 (`PAY-DEC-002`, `-006`),
-- 02 (`RC-DEC-005`); ADR-0011 (revision/CAS), ADR-0017 (RLS + roles),
-- ADR-0018 (audit).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- =====================================================================
-- The booking
-- =====================================================================

-- `BK-DEC-012`: one booking is one room of one category for one primary
-- staying guest, nightly only. The booker is the Guest account that paid; the
-- staying guest is recorded here as contact detail and verified for real at
-- check-in, by Reception, through the Phase 08 identity path. The two are never
-- assumed to be the same person (doc 09 §6.4).
CREATE TABLE platform.booking (
  booking_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id               uuid NOT NULL,
  -- Short, human-quotable, and unique across the platform: a guest reads it
  -- down the phone and Reception types it at check-in.
  booking_ref            text NOT NULL,
  category_id            uuid NOT NULL,
  -- The Guest realm account that made the booking (Phase 12). Account-global,
  -- so the column carries no realm: `guest_account` already constrains it.
  booker_account_id      uuid NOT NULL,
  -- doc 09 §6.4: what the booker typed about who will stay. Not an identity.
  staying_guest_name     text NOT NULL,
  staying_guest_phone_token text,
  -- `[check_in_date, check_out_date)`, whole nights, end-exclusive.
  check_in_date          date NOT NULL,
  check_out_date         date NOT NULL,
  night_count            integer NOT NULL,
  -- The snapshot taken when the price was quoted, and again when it was paid.
  -- Never re-resolved from current configuration (doc 09 §10).
  rate_snapshot_id       uuid,
  unit_rate_mnt          bigint,
  total_amount_mnt       bigint,
  pricing_config_version integer,
  state                  text NOT NULL DEFAULT 'HOLDING',
  -- `BK-DEC-009`: ten minutes from creation, written once.
  hold_expires_at        timestamptz NOT NULL,
  hold_state             text NOT NULL DEFAULT 'ACTIVE',
  payment_state          text NOT NULL DEFAULT 'PENDING',
  refund_state           text NOT NULL DEFAULT 'NONE',
  confirmed_at           timestamptz,
  terminal_at            timestamptz,
  terminal_reason        text,
  -- The stay this booking became, once Reception checked it in.
  fulfilled_stay_id      uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  revision               integer NOT NULL DEFAULT 0,
  CONSTRAINT booking_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT booking_category_fkey FOREIGN KEY (hotel_id, category_id)
    REFERENCES platform.room_category (hotel_id, category_id) ON DELETE RESTRICT,
  CONSTRAINT booking_booker_fkey FOREIGN KEY (booker_account_id)
    REFERENCES platform.guest_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT booking_identity_uq UNIQUE (hotel_id, booking_id),
  -- doc 09 §8: the booking axis, and nothing else on it.
  CONSTRAINT booking_state_known
    CHECK (state = ANY (ARRAY['HOLDING'::text, 'CONFIRMED'::text, 'CHECKED_IN'::text,
                              'COMPLETED'::text, 'EXPIRED'::text, 'CANCELLED_GUEST'::text,
                              'CANCELLED_HOTEL'::text, 'NO_SHOW'::text])),
  CONSTRAINT booking_hold_state_known
    CHECK (hold_state = ANY (ARRAY['ACTIVE'::text, 'CONSUMED'::text, 'EXPIRED'::text,
                                   'CANCELLED'::text])),
  CONSTRAINT booking_payment_state_known
    CHECK (payment_state = ANY (ARRAY['PENDING'::text, 'PAID'::text, 'FAILED'::text,
                                      'EXPIRED'::text])),
  CONSTRAINT booking_refund_state_known
    CHECK (refund_state = ANY (ARRAY['NONE'::text, 'REQUIRED'::text, 'PENDING'::text,
                                     'PARTIALLY_REFUNDED'::text, 'REFUNDED'::text,
                                     'FAILED'::text])),
  CONSTRAINT booking_ref_shape CHECK (booking_ref ~ '^[A-Z0-9]{8,12}$'::text),
  CONSTRAINT booking_nightly_window
    CHECK (check_out_date > check_in_date
           AND night_count = (check_out_date - check_in_date)
           AND night_count BETWEEN 1 AND 90),
  CONSTRAINT booking_guest_name_bounded
    CHECK (length(staying_guest_name) BETWEEN 1 AND 200),
  CONSTRAINT booking_guest_phone_shape
    CHECK (staying_guest_phone_token IS NULL
           OR staying_guest_phone_token ~ '^[0-9a-f]{64}$'::text),
  -- A booking that was confirmed carries the price it was confirmed at, whole.
  -- A booking that never was — one that expired or was cancelled while still
  -- holding — carries none, and requiring one of it would be requiring a price
  -- that was never agreed.
  CONSTRAINT booking_confirmed_has_snapshot
    CHECK (state <> ALL (ARRAY['CONFIRMED'::text, 'CHECKED_IN'::text, 'COMPLETED'::text])
           OR (rate_snapshot_id IS NOT NULL AND unit_rate_mnt IS NOT NULL
               AND total_amount_mnt IS NOT NULL AND pricing_config_version IS NOT NULL)),
  CONSTRAINT booking_confirmed_has_time
    CHECK ((state = ANY (ARRAY['CONFIRMED'::text, 'CHECKED_IN'::text, 'COMPLETED'::text]))
           = (confirmed_at IS NOT NULL)),
  -- doc 09 §8: a terminal booking is stamped, and a live one is not.
  CONSTRAINT booking_terminal_shape
    CHECK ((state = ANY (ARRAY['EXPIRED'::text, 'CANCELLED_GUEST'::text, 'CANCELLED_HOTEL'::text,
                               'NO_SHOW'::text, 'COMPLETED'::text]))
           = (terminal_at IS NOT NULL)),
  -- `BK-DEC-013`: the stay exists exactly when the booking has been checked in.
  CONSTRAINT booking_fulfilled_shape
    CHECK ((fulfilled_stay_id IS NOT NULL)
           = (state = ANY (ARRAY['CHECKED_IN'::text, 'COMPLETED'::text]))),
  -- `BK-DEC-014` and `PAY-DEC-006`: a hotel cancellation and a late capture both
  -- owe the guest their money back. An unpaid booking owes nothing.
  CONSTRAINT booking_refund_needs_payment
    CHECK (refund_state = 'NONE'::text OR payment_state = 'PAID'::text),
  CONSTRAINT booking_hotel_cancellation_refunds
    CHECK (state <> 'CANCELLED_HOTEL'::text
           OR payment_state <> 'PAID'::text
           OR refund_state <> 'NONE'::text),
  CONSTRAINT booking_amounts_non_negative
    CHECK ((unit_rate_mnt IS NULL OR unit_rate_mnt >= 0)
           AND (total_amount_mnt IS NULL OR total_amount_mnt >= 0)),
  CONSTRAINT booking_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX booking_ref_uq ON platform.booking (booking_ref);
--> statement-breakpoint
CREATE INDEX booking_hotel_state_idx ON platform.booking (hotel_id, state, check_in_date);
--> statement-breakpoint
CREATE INDEX booking_booker_idx ON platform.booking (booker_account_id, created_at DESC);
--> statement-breakpoint
-- The expiry sweep reads exactly this: live holds whose ten minutes are up.
CREATE INDEX booking_expiry_idx ON platform.booking (hold_expires_at)
  WHERE hold_state = 'ACTIVE'::text;
--> statement-breakpoint
CREATE INDEX booking_category_window_idx
  ON platform.booking (hotel_id, category_id, check_in_date, check_out_date);
--> statement-breakpoint

-- doc 09 §8: every transition is row-locked, keyed and forward-only. The guard
-- states which of those the database itself will not let go backwards.
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
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER booking_update_guard
  BEFORE UPDATE ON platform.booking
  FOR EACH ROW EXECUTE FUNCTION platform.booking_guard();
--> statement-breakpoint
CREATE TRIGGER booking_no_delete
  BEFORE DELETE ON platform.booking
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

ALTER TABLE platform.booking ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.booking FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.booking
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- A Guest must be able to read the booking they made, and nothing else.
--
-- Confined exactly the way Phase 04 confines a member reading their own
-- membership: it matches only under the platform sentinel, which no hotel
-- carries as its id, so inside a hotel scope it matches nothing at all. The two
-- policies are disjoint by construction. This is a *read*: creating,
-- confirming and cancelling a booking are commands that run in the hotel's own
-- scope with the Guest identity bound by the server, never by the request.
CREATE POLICY own_booking_read ON platform.booking
  FOR SELECT USING (
    platform.current_hotel_id() = '00000000-0000-0000-0000-000000000000'::uuid
    AND booker_account_id = platform.current_account_id()
  );
--> statement-breakpoint

-- =====================================================================
-- The nights a booking occupies
-- =====================================================================

-- One row per booking per night. The child rows are what make the occupancy
-- arithmetic exact: a booking is not "a range that probably overlaps", it is
-- the specific nights it took, and releasing it is releasing those.
CREATE TABLE platform.booking_night (
  booking_id  uuid NOT NULL,
  hotel_id    uuid NOT NULL,
  category_id uuid NOT NULL,
  night       date NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_night_pkey PRIMARY KEY (booking_id, night),
  CONSTRAINT booking_night_booking_fkey FOREIGN KEY (hotel_id, booking_id)
    REFERENCES platform.booking (hotel_id, booking_id) ON DELETE RESTRICT,
  CONSTRAINT booking_night_category_fkey FOREIGN KEY (hotel_id, category_id)
    REFERENCES platform.room_category (hotel_id, category_id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX booking_night_category_idx ON platform.booking_night (hotel_id, category_id, night);
--> statement-breakpoint
CREATE TRIGGER booking_night_append_only
  BEFORE UPDATE ON platform.booking_night
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

ALTER TABLE platform.booking_night ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.booking_night FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.booking_night
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- The inventory the database refuses to oversell
-- =====================================================================

-- `BK-DEC-013`, doc 09 §10: one row per category per night, carrying the
-- capacity that night and the units taken. Every path that changes occupancy —
-- a hold, a confirmation, an expiry, a cancellation, a check-in, a walk-in —
-- locks these rows in night order and writes them, so the count is never
-- computed in one statement and acted on in another.
--
-- `units_capacity` is the eligible `ACTIVE` room count, refreshed on every
-- write from the rooms as they are at that moment; `units_held` is what active
-- holds, confirmed bookings and active stays have taken. The `CHECK` is the
-- whole anti-overbooking rule, and it is the database's, not a query's.
CREATE TABLE platform.category_night_inventory (
  hotel_id       uuid NOT NULL,
  category_id    uuid NOT NULL,
  night          date NOT NULL,
  units_capacity integer NOT NULL,
  units_held     integer NOT NULL DEFAULT 0,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  revision       integer NOT NULL DEFAULT 0,
  CONSTRAINT category_night_inventory_pkey PRIMARY KEY (hotel_id, category_id, night),
  CONSTRAINT category_night_inventory_category_fkey FOREIGN KEY (hotel_id, category_id)
    REFERENCES platform.room_category (hotel_id, category_id) ON DELETE RESTRICT,
  CONSTRAINT category_night_inventory_capacity_non_negative CHECK (units_capacity >= 0),
  -- The rule this table exists for.
  CONSTRAINT category_night_inventory_within_capacity
    CHECK (units_held >= 0 AND units_held <= units_capacity),
  CONSTRAINT category_night_inventory_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE TRIGGER category_night_inventory_no_delete
  BEFORE DELETE ON platform.category_night_inventory
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

ALTER TABLE platform.category_night_inventory ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.category_night_inventory FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.category_night_inventory
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- The payment attempt
-- =====================================================================

-- doc 09 §8: the attempt axis is its own. A guest who switches provider gets a
-- new attempt and the old one becomes `SUPERSEDED`; exactly one attempt is
-- `ACTIVE` at a time, which the partial unique index holds rather than the
-- application. Capture, refund and settlement are Phase 14's — this records
-- that an attempt existed, what the provider called it, and how it ended.
CREATE TABLE platform.booking_payment_attempt (
  attempt_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id            uuid NOT NULL,
  booking_id          uuid NOT NULL,
  provider            text NOT NULL,
  provider_invoice_id text,
  amount_mnt          bigint NOT NULL,
  state               text NOT NULL DEFAULT 'ACTIVE',
  -- `BK-DEC-009`: no session outlives the hold that authorized it.
  expires_at          timestamptz NOT NULL,
  settled_at          timestamptz,
  settled_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT booking_payment_attempt_booking_fkey FOREIGN KEY (hotel_id, booking_id)
    REFERENCES platform.booking (hotel_id, booking_id) ON DELETE RESTRICT,
  CONSTRAINT booking_payment_attempt_provider_known
    CHECK (provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text])),
  CONSTRAINT booking_payment_attempt_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'SUPERSEDED'::text, 'PAID'::text, 'FAILED'::text,
                              'EXPIRED'::text])),
  CONSTRAINT booking_payment_attempt_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT booking_payment_attempt_settled_shape
    CHECK ((state = 'ACTIVE'::text) = (settled_at IS NULL)),
  CONSTRAINT booking_payment_attempt_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- One live attempt per booking.
CREATE UNIQUE INDEX booking_payment_attempt_one_active_uq
  ON platform.booking_payment_attempt (booking_id)
  WHERE state = 'ACTIVE'::text;
--> statement-breakpoint
-- `PAY-DEC-006`: one captured transaction reaches the ledger once. A provider
-- invoice identifies the attempt it belongs to, and cannot identify two.
CREATE UNIQUE INDEX booking_payment_attempt_invoice_uq
  ON platform.booking_payment_attempt (provider, provider_invoice_id)
  WHERE provider_invoice_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX booking_payment_attempt_booking_idx
  ON platform.booking_payment_attempt (booking_id, created_at DESC);
--> statement-breakpoint

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
    RAISE EXCEPTION 'a payment attempt and its window are immutable' USING ERRCODE = '42501';
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
CREATE TRIGGER booking_payment_attempt_update_guard
  BEFORE UPDATE ON platform.booking_payment_attempt
  FOR EACH ROW EXECUTE FUNCTION platform.booking_payment_attempt_guard();
--> statement-breakpoint
CREATE TRIGGER booking_payment_attempt_no_delete
  BEFORE DELETE ON platform.booking_payment_attempt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

ALTER TABLE platform.booking_payment_attempt ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.booking_payment_attempt FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.booking_payment_attempt
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- The booking's own history
-- =====================================================================

-- Append-only, like every other lifecycle history in this schema: a booking
-- that expired and a booking that was cancelled by its guest are different
-- facts, and neither is recoverable from the row's current state alone.
CREATE TABLE platform.booking_event (
  event_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      uuid NOT NULL,
  booking_id    uuid NOT NULL,
  event_type    text NOT NULL,
  from_state    text,
  to_state      text,
  actor_ref     text NOT NULL,
  reason        text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT booking_event_booking_fkey FOREIGN KEY (hotel_id, booking_id)
    REFERENCES platform.booking (hotel_id, booking_id) ON DELETE RESTRICT,
  CONSTRAINT booking_event_type_bounded CHECK (length(event_type) BETWEEN 1 AND 80),
  CONSTRAINT booking_event_actor_bounded CHECK (length(actor_ref) BETWEEN 1 AND 120),
  CONSTRAINT booking_event_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300)
);
--> statement-breakpoint

CREATE INDEX booking_event_booking_idx ON platform.booking_event (booking_id, occurred_at);
--> statement-breakpoint
CREATE TRIGGER booking_event_append_only
  BEFORE UPDATE OR DELETE ON platform.booking_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

ALTER TABLE platform.booking_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.booking_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.booking_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- The stay carries the booking it fulfilled
-- =====================================================================

-- Phase 08 recorded `booking_ref` as free text, because no booking table
-- existed to point at. It does now, and an online stay names the row.
ALTER TABLE platform.stay
  ADD COLUMN fulfilled_booking_id uuid;
--> statement-breakpoint
ALTER TABLE platform.stay
  ADD CONSTRAINT stay_booking_fkey FOREIGN KEY (hotel_id, fulfilled_booking_id)
    REFERENCES platform.booking (hotel_id, booking_id) ON DELETE RESTRICT;
--> statement-breakpoint
-- `BK-DEC-013`: a booking becomes exactly one stay.
CREATE UNIQUE INDEX stay_fulfilled_booking_uq ON platform.stay (fulfilled_booking_id)
  WHERE fulfilled_booking_id IS NOT NULL;
--> statement-breakpoint

-- =====================================================================
-- Grants
-- =====================================================================

-- The API holds the booking lifecycle. The worker holds the expiry sweep — the
-- one job of this phase — which reads live holds and settles them, and reads
-- and writes the inventory it releases.
-- The API creates bookings, nights, inventory rows and attempts. The worker
-- only *settles* what already exists: the expiry sweep updates the booking, the
-- inventory it releases and the attempt it expires, and records the event. It
-- creates nothing, so it holds no INSERT except on the history.
GRANT SELECT, INSERT, UPDATE ON platform.booking                  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.booking                  TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.booking_night            TO prsystem_api;
--> statement-breakpoint
GRANT SELECT                 ON platform.booking_night            TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.category_night_inventory TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.category_night_inventory TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.booking_payment_attempt  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.booking_payment_attempt  TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.booking_event            TO prsystem_api, prsystem_worker;
--> statement-breakpoint

-- =====================================================================
-- Resolving the hotel a booking belongs to
-- =====================================================================

-- A Guest names a room category; the hotel is the server's to determine, and a
-- hotel id in a request must never select the tenant a command runs in. The
-- category is a tenant row, so this crosses the boundary the same narrow way
-- Phase 05's pre-tenant probes do: a `SECURITY DEFINER` function owned by the
-- login-less resolver role, answering one identifier and nothing else.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform.hotel_of_category(p_category_id uuid)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.hotel_id
    FROM platform.room_category c
    JOIN platform.hotel_profile p ON p.hotel_id = c.hotel_id
   WHERE c.category_id = p_category_id
     AND c.state = 'ACTIVE'::text
     AND p.listing_state = 'PUBLISHED'::text
$$;
--> statement-breakpoint
ALTER FUNCTION platform.hotel_of_category(uuid) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.hotel_of_category(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.hotel_of_category(uuid) TO prsystem_api;
--> statement-breakpoint
-- doc 09 §5: a public search must subtract what bookings hold, and it runs with
-- no tenant of its own — the same reason Phase 12's listing projection is a
-- definer function. Per hotel and category, the worst night decides: a category
-- with one free unit on one night of a three-night stay can sell no three-night
-- stay at all.
CREATE OR REPLACE FUNCTION platform.public_category_holds(
  p_hotel_ids uuid[],
  p_nights    date[]
) RETURNS TABLE (hotel_id uuid, category_id uuid, held bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT per_night.hotel_id, per_night.category_id, pg_catalog.max(per_night.taken) AS held
    FROM (
      SELECT n.hotel_id, n.category_id, n.night, pg_catalog.count(*) AS taken
        FROM platform.booking_night n
        JOIN platform.booking b ON b.booking_id = n.booking_id
       WHERE n.hotel_id = ANY (p_hotel_ids)
         AND n.night = ANY (p_nights)
         AND b.state = ANY (ARRAY['HOLDING'::text, 'CONFIRMED'::text])
       GROUP BY n.hotel_id, n.category_id, n.night
    ) per_night
   GROUP BY per_night.hotel_id, per_night.category_id
$$;
--> statement-breakpoint
ALTER FUNCTION platform.public_category_holds(uuid[], date[]) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

-- The expiry sweep runs as a job, with no tenant either: it has to find lapsed
-- holds across every hotel before it can settle any of them. It answers two
-- identifiers per row and nothing else; the settling itself happens in the
-- hotel's own scope, on the booking's own lock.
CREATE OR REPLACE FUNCTION platform.lapsed_booking_holds(
  p_limit integer,
  p_now   timestamptz DEFAULT NULL
) RETURNS TABLE (booking_id uuid, hotel_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT b.booking_id, b.hotel_id
    FROM platform.booking b
   WHERE b.hold_state = 'ACTIVE'::text
     AND b.state = 'HOLDING'::text
     AND b.hold_expires_at <= coalesce(p_now, pg_catalog.now())
   ORDER BY b.hold_expires_at
   LIMIT p_limit
$$;
--> statement-breakpoint
ALTER FUNCTION platform.lapsed_booking_holds(integer, timestamptz)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  platform.public_category_holds(uuid[], date[]),
  platform.lapsed_booking_holds(integer, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.public_category_holds(uuid[], date[]) TO prsystem_api;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.lapsed_booking_holds(integer, timestamptz)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.booking_night TO prsystem_maintenance_fn;
--> statement-breakpoint

REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT ON platform.room_category TO prsystem_maintenance_fn;
--> statement-breakpoint

-- The public listing projection now subtracts what bookings hold. Phase 12's
-- resolver role reads the two tables through the same narrow policies.
CREATE POLICY public_availability_read ON platform.booking
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = booking.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
CREATE POLICY public_availability_read ON platform.booking_night
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = booking_night.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
CREATE POLICY public_availability_read ON platform.category_night_inventory
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = category_night_inventory.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
GRANT SELECT ON platform.booking, platform.category_night_inventory TO prsystem_maintenance_fn;
--> statement-breakpoint
