-- =====================================================================
-- 0016 — Restaurant registration, guest access, ordering and refunds
--
-- The Restaurant is the one money path in this platform that does **not**
-- belong to the platform (`RC-DEC-021`, doc 08 §13). A guest's food payment goes
-- to the restaurant's own QPay merchant and never through the platform's
-- account; the platform records that an order exists, that an invoice was
-- raised, and what the provider said about it. Nothing here settles anything,
-- and nothing here reaches the hotel's folio, deposit, cash drawer or shift
-- totals — doc 08 §8 and doc 24 §1 keep those apart, and the separation is
-- structural: no table below carries a folio, deposit, drawer or shift
-- reference, and none of theirs carries an order.
--
-- Four rules shape the tables.
--
-- **Seven axes, never collapsed** (`REST-DEC-001`, doc 08 §10). Order,
-- fulfilment, payment, refund policy, refund request, refund execution and
-- handoff mode are seven columns with seven CHECKs. A late capture on a
-- cancelled order moves the payment axis and nothing else.
--
-- **The provider is the only authority** on `payment = PAID` and
-- `refund = REFUNDED`. No hotel or restaurant role may write either by hand,
-- and doc 08 §11 says so in as many words.
--
-- **An invoice never outlives the day's ordering close** (`RC-DEC-023`). The
-- close is snapshotted onto the order and the attempt's expiry is CHECKed
-- against it, so the rule is a property of the row rather than of the code that
-- wrote it.
--
-- **Five sessions per stay, counted by the database** (`RC-DEC-027`). Active
-- sessions plus valid unused codes are a counter row with
-- `CHECK (active + pending <= 5)`, taken under a row lock — the same shape
-- Phase 13 used to make overbooking a constraint violation rather than a race.
-- =====================================================================

-- =====================================================================
-- The restaurant, and its link to a hotel
-- =====================================================================

-- doc 08 §3. Registered by Manager Plus on a 30,000₮ package; the *link* is
-- where activation lives, so one restaurant can later be linked to more than
-- one hotel on separate terms (doc 08 §4).
CREATE TABLE platform.restaurant (
  restaurant_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The hotel whose Manager Plus registered it. The tenant that owns the row;
  -- activation for *a* hotel is on `hotel_restaurant_link`.
  hotel_id          uuid NOT NULL,
  display_name      text NOT NULL,
  cuisine_kind      text NOT NULL,
  description       text,
  address_line      text NOT NULL,
  -- Integer micro-degrees, as Phase 12's listing coordinates are: a location is
  -- never a float.
  latitude_micro    integer NOT NULL,
  longitude_micro   integer NOT NULL,
  -- doc 08 §7: the order contact. A restaurant's own business number, shown to
  -- a guest who has ordered and to nobody else — never a guest's own number.
  contact_phone     text NOT NULL,
  timezone          text NOT NULL DEFAULT 'Asia/Ulaanbaatar',
  state             text NOT NULL DEFAULT 'ACTIVE',
  created_at        timestamptz NOT NULL DEFAULT now(),
  revision          integer NOT NULL DEFAULT 0,
  CONSTRAINT restaurant_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_identity_uq UNIQUE (hotel_id, restaurant_id),
  CONSTRAINT restaurant_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text])),
  CONSTRAINT restaurant_name_bounded CHECK (length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT restaurant_kind_bounded CHECK (length(cuisine_kind) BETWEEN 1 AND 80),
  CONSTRAINT restaurant_description_bounded
    CHECK (description IS NULL OR length(description) BETWEEN 1 AND 2000),
  CONSTRAINT restaurant_address_bounded CHECK (length(address_line) BETWEEN 1 AND 300),
  CONSTRAINT restaurant_position_bounded
    CHECK (latitude_micro BETWEEN -90000000 AND 90000000
           AND longitude_micro BETWEEN -180000000 AND 180000000),
  CONSTRAINT restaurant_phone_shape CHECK (contact_phone ~ '^\+976[0-9]{8}$'::text),
  CONSTRAINT restaurant_timezone_known CHECK (timezone = 'Asia/Ulaanbaatar'::text),
  CONSTRAINT restaurant_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX restaurant_hotel_idx ON platform.restaurant (hotel_id, state);
--> statement-breakpoint

-- doc 08 §4: activation is per hotel, and the SLA pause of `RC-DEC-031` is a
-- *separate* fact from it — a link the platform paused for an unresolved refund
-- must not silently become active again when the pause lifts if Manager Plus
-- had already switched it off by hand.
CREATE TABLE platform.hotel_restaurant_link (
  link_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id           uuid NOT NULL,
  restaurant_id      uuid NOT NULL,
  link_state         text NOT NULL DEFAULT 'ACTIVE',
  -- `RC-DEC-031`: new orders are refused while a refund request has gone
  -- unresolved for thirty minutes. Automatic, and lifted automatically.
  sla_paused         boolean NOT NULL DEFAULT false,
  sla_paused_at      timestamptz,
  sla_paused_reason  text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  revision           integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_restaurant_link_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_restaurant_link_restaurant_fkey FOREIGN KEY (hotel_id, restaurant_id)
    REFERENCES platform.restaurant (hotel_id, restaurant_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_restaurant_link_uq UNIQUE (hotel_id, restaurant_id),
  CONSTRAINT hotel_restaurant_link_identity_uq UNIQUE (hotel_id, link_id),
  CONSTRAINT hotel_restaurant_link_state_known
    CHECK (link_state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])),
  CONSTRAINT hotel_restaurant_link_pause_shape
    CHECK (sla_paused = (sla_paused_at IS NOT NULL)),
  CONSTRAINT hotel_restaurant_link_pause_reason_bounded
    CHECK (sla_paused_reason IS NULL OR length(sla_paused_reason) BETWEEN 1 AND 200),
  CONSTRAINT hotel_restaurant_link_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- =====================================================================
-- The ordering schedule
-- =====================================================================

-- doc 08 §5. One row per weekday, and an override that outranks it for one
-- calendar date. An overnight window — `18:00–02:00` — is the case where
-- `closes_at <= opens_at`, and is why the domain reasons in local wall-clock
-- terms rather than by comparing two instants.
CREATE TABLE platform.restaurant_schedule (
  schedule_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      uuid NOT NULL,
  restaurant_id uuid NOT NULL,
  -- 0 = Sunday, matching PostgreSQL's `EXTRACT(dow)`.
  weekday       integer NOT NULL,
  closed        boolean NOT NULL DEFAULT false,
  opens_at      time,
  closes_at     time,
  revision      integer NOT NULL DEFAULT 0,
  CONSTRAINT restaurant_schedule_restaurant_fkey FOREIGN KEY (hotel_id, restaurant_id)
    REFERENCES platform.restaurant (hotel_id, restaurant_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_schedule_uq UNIQUE (restaurant_id, weekday),
  CONSTRAINT restaurant_schedule_weekday_known CHECK (weekday BETWEEN 0 AND 6),
  -- A day is either closed and carries no window, or open and carries both
  -- ends of one. There is no third shape.
  CONSTRAINT restaurant_schedule_window_shape
    CHECK (closed = (opens_at IS NULL) AND closed = (closes_at IS NULL)),
  CONSTRAINT restaurant_schedule_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- doc 08 §5: a special holiday or a temporary closure, outranking the weekly
-- schedule for exactly one hotel-local date.
CREATE TABLE platform.restaurant_schedule_override (
  override_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id      uuid NOT NULL,
  restaurant_id uuid NOT NULL,
  local_date    date NOT NULL,
  closed        boolean NOT NULL DEFAULT true,
  opens_at      time,
  closes_at     time,
  reason        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_schedule_override_restaurant_fkey FOREIGN KEY (hotel_id, restaurant_id)
    REFERENCES platform.restaurant (hotel_id, restaurant_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_schedule_override_uq UNIQUE (restaurant_id, local_date),
  CONSTRAINT restaurant_schedule_override_window_shape
    CHECK (closed = (opens_at IS NULL) AND closed = (closes_at IS NULL)),
  CONSTRAINT restaurant_schedule_override_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 200)
);
--> statement-breakpoint

-- =====================================================================
-- The menu
-- =====================================================================

CREATE TABLE platform.restaurant_menu_category (
  menu_category_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  restaurant_id    uuid NOT NULL,
  name             text NOT NULL,
  sort_order       integer NOT NULL DEFAULT 0,
  state            text NOT NULL DEFAULT 'ACTIVE',
  created_at       timestamptz NOT NULL DEFAULT now(),
  revision         integer NOT NULL DEFAULT 0,
  CONSTRAINT restaurant_menu_category_restaurant_fkey FOREIGN KEY (hotel_id, restaurant_id)
    REFERENCES platform.restaurant (hotel_id, restaurant_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_menu_category_identity_uq UNIQUE (restaurant_id, menu_category_id),
  CONSTRAINT restaurant_menu_category_name_uq UNIQUE (restaurant_id, name),
  CONSTRAINT restaurant_menu_category_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])),
  CONSTRAINT restaurant_menu_category_name_bounded CHECK (length(name) BETWEEN 1 AND 120),
  CONSTRAINT restaurant_menu_category_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- doc 08 §6: the price is the server's. A basket total is recomputed from these
-- rows at confirmation and never taken from the guest's device.
CREATE TABLE platform.restaurant_menu_item (
  item_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  restaurant_id    uuid NOT NULL,
  menu_category_id uuid NOT NULL,
  name             text NOT NULL,
  description      text,
  -- Whole MNT. Never a float, never a client-supplied figure.
  price_mnt        bigint NOT NULL,
  -- doc 08 §6: "бэлэн/дууссан" — in stock right now, distinct from whether the
  -- item is on the menu at all.
  available        boolean NOT NULL DEFAULT true,
  state            text NOT NULL DEFAULT 'ACTIVE',
  image_object_key text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  revision         integer NOT NULL DEFAULT 0,
  CONSTRAINT restaurant_menu_item_category_fkey FOREIGN KEY (restaurant_id, menu_category_id)
    REFERENCES platform.restaurant_menu_category (restaurant_id, menu_category_id)
    ON DELETE RESTRICT,
  CONSTRAINT restaurant_menu_item_restaurant_fkey FOREIGN KEY (hotel_id, restaurant_id)
    REFERENCES platform.restaurant (hotel_id, restaurant_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_menu_item_identity_uq UNIQUE (restaurant_id, item_id),
  CONSTRAINT restaurant_menu_item_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])),
  CONSTRAINT restaurant_menu_item_name_bounded CHECK (length(name) BETWEEN 1 AND 200),
  CONSTRAINT restaurant_menu_item_description_bounded
    CHECK (description IS NULL OR length(description) BETWEEN 1 AND 1000),
  CONSTRAINT restaurant_menu_item_price_positive CHECK (price_mnt > 0),
  CONSTRAINT restaurant_menu_item_image_bounded
    CHECK (image_object_key IS NULL OR length(image_object_key) BETWEEN 1 AND 300),
  CONSTRAINT restaurant_menu_item_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX restaurant_menu_item_menu_idx
  ON platform.restaurant_menu_item (restaurant_id, menu_category_id, state);
--> statement-breakpoint

-- =====================================================================
-- Guest access: the room's QR, the one-time code, the session
-- =====================================================================

-- `RC-DEC-026`: the QR in the room is a permanent, opaque *starting point* and
-- never an authorization by itself. It carries no room number and no stay id —
-- only a token this row is found by — and the token is stored as a keyed hash,
-- so a leaked database gives nobody a working QR.
CREATE TABLE platform.room_access_token (
  room_access_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id       uuid NOT NULL,
  room_id        uuid NOT NULL,
  token_hash     text NOT NULL,
  token_version  integer NOT NULL DEFAULT 1,
  state          text NOT NULL DEFAULT 'ACTIVE',
  issued_at      timestamptz NOT NULL DEFAULT now(),
  rotated_at     timestamptz,
  revision       integer NOT NULL DEFAULT 0,
  CONSTRAINT room_access_token_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT room_access_token_hash_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT room_access_token_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'ROTATED'::text])),
  CONSTRAINT room_access_token_rotated_shape
    CHECK ((state = 'ROTATED'::text) = (rotated_at IS NOT NULL)),
  CONSTRAINT room_access_token_version_positive CHECK (token_version > 0),
  CONSTRAINT room_access_token_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
-- One live QR per room, and a token that identifies exactly one room.
CREATE UNIQUE INDEX room_access_token_room_uq
  ON platform.room_access_token (room_id)
  WHERE state = 'ACTIVE'::text;
--> statement-breakpoint
CREATE UNIQUE INDEX room_access_token_hash_uq ON platform.room_access_token (token_hash);
--> statement-breakpoint

-- `RC-DEC-027`: five, counted by the database.
--
-- Active sessions **plus valid unused codes** may not exceed five, and both
-- halves move through this one row under its own lock. A counter with a CHECK
-- is the same answer Phase 13 gave to overbooking, for the same reason: a count
-- taken in one statement and acted on in another is a race with a name, and
-- doc 08 §7 asks explicitly that two codes confirmed at once cannot exceed the
-- limit.
CREATE TABLE platform.stay_guest_access (
  stay_id         uuid PRIMARY KEY,
  hotel_id        uuid NOT NULL,
  room_id         uuid NOT NULL,
  active_sessions integer NOT NULL DEFAULT 0,
  pending_codes   integer NOT NULL DEFAULT 0,
  closed_at       timestamptz,
  revision        integer NOT NULL DEFAULT 0,
  CONSTRAINT stay_guest_access_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT stay_guest_access_identity_uq UNIQUE (hotel_id, stay_id),
  CONSTRAINT stay_guest_access_counts_non_negative
    CHECK (active_sessions >= 0 AND pending_codes >= 0),
  CONSTRAINT stay_guest_access_within_limit
    CHECK (active_sessions + pending_codes <= 5),
  CONSTRAINT stay_guest_access_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- doc 08 §7: a 4–6 digit code, issued by Reception at check-in and for each
-- extra device. Stored as a keyed hash and never in plaintext — not in this
-- row, not in a log and not in an audit payload (CLAUDE.md §8).
CREATE TABLE platform.guest_access_code (
  code_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id       uuid NOT NULL,
  stay_id        uuid NOT NULL,
  room_id        uuid NOT NULL,
  code_hash      text NOT NULL,
  key_version    text NOT NULL,
  state          text NOT NULL DEFAULT 'PENDING',
  attempts       integer NOT NULL DEFAULT 0,
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  settled_at     timestamptz,
  issued_by_account_id uuid NOT NULL,
  revision       integer NOT NULL DEFAULT 0,
  CONSTRAINT guest_access_code_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT guest_access_code_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT guest_access_code_hash_shape CHECK (code_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT guest_access_code_key_version_bounded CHECK (length(key_version) BETWEEN 1 AND 40),
  CONSTRAINT guest_access_code_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'USED'::text, 'REVOKED'::text,
                              'EXPIRED'::text])),
  CONSTRAINT guest_access_code_settled_shape
    CHECK ((state = 'PENDING'::text) = (settled_at IS NULL)),
  CONSTRAINT guest_access_code_attempts_bounded CHECK (attempts BETWEEN 0 AND 10),
  CONSTRAINT guest_access_code_window CHECK (expires_at > issued_at),
  CONSTRAINT guest_access_code_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX guest_access_code_stay_idx ON platform.guest_access_code (stay_id, state);
--> statement-breakpoint

-- The session a confirmed code creates. Bound to one hotel, one room and one
-- stay, all three of them the server's: doc 08 §7 refuses the guest any choice
-- of room number, and this row is why there is none to make.
CREATE TABLE platform.guest_session (
  guest_session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  stay_id          uuid NOT NULL,
  room_id          uuid NOT NULL,
  token_hash       text NOT NULL,
  code_id          uuid NOT NULL,
  state            text NOT NULL DEFAULT 'ACTIVE',
  created_at       timestamptz NOT NULL DEFAULT now(),
  expires_at       timestamptz NOT NULL,
  revoked_at       timestamptz,
  revoked_reason   text,
  revision         integer NOT NULL DEFAULT 0,
  CONSTRAINT guest_session_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT guest_session_code_fkey FOREIGN KEY (code_id)
    REFERENCES platform.guest_access_code (code_id) ON DELETE RESTRICT,
  -- One session per code: a code is one device's, and it is spent by creating
  -- exactly one.
  CONSTRAINT guest_session_code_uq UNIQUE (code_id),
  CONSTRAINT guest_session_identity_uq UNIQUE (hotel_id, guest_session_id),
  CONSTRAINT guest_session_token_shape CHECK (token_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT guest_session_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'REVOKED'::text, 'EXPIRED'::text])),
  CONSTRAINT guest_session_revoked_shape
    CHECK ((state = 'ACTIVE'::text) = (revoked_at IS NULL)),
  CONSTRAINT guest_session_reason_bounded
    CHECK (revoked_reason IS NULL OR length(revoked_reason) BETWEEN 1 AND 120),
  CONSTRAINT guest_session_window CHECK (expires_at > created_at),
  CONSTRAINT guest_session_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX guest_session_token_uq ON platform.guest_session (token_hash);
--> statement-breakpoint
CREATE INDEX guest_session_stay_idx ON platform.guest_session (stay_id, state);
--> statement-breakpoint

-- =====================================================================
-- The order, on seven axes
-- =====================================================================

-- doc 08 §10 / `REST-DEC-001`. Seven columns, seven CHECKs, and no derived
-- "status" anywhere: a late capture on a cancelled order moves `payment_state`
-- and leaves the other six exactly where they were.
CREATE TABLE platform.restaurant_order (
  order_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id              uuid NOT NULL,
  restaurant_id         uuid NOT NULL,
  stay_id               uuid NOT NULL,
  room_id               uuid NOT NULL,
  -- The device that placed it. A guest reads their own order through this.
  guest_session_id      uuid NOT NULL,
  order_no              text NOT NULL,
  -- Snapshotted at confirmation (doc 08 §11): the price the guest agreed to,
  -- and the number they were shown to call.
  total_amount_mnt      bigint NOT NULL,
  contact_phone_snapshot text NOT NULL,
  -- `RC-DEC-023`: the day's ordering close, snapshotted so the invoice's own
  -- expiry can be checked against it without re-deriving a schedule.
  ordering_closes_at    timestamptz NOT NULL,
  guest_note            text,

  order_state           text NOT NULL DEFAULT 'PENDING_PAYMENT',
  fulfillment_state     text NOT NULL DEFAULT 'NOT_STARTED',
  payment_state         text NOT NULL DEFAULT 'PENDING',
  refund_policy         text NOT NULL DEFAULT 'NONE',
  refund_request_state  text NOT NULL DEFAULT 'NONE',
  refund_state          text NOT NULL DEFAULT 'NONE',
  handoff_mode          text NOT NULL DEFAULT 'ROOM',

  refund_reason         text,
  reject_reason         text,
  -- `RC-DEC-030`: every SLA below is measured from the instant the *server*
  -- confirmed the payment, never from a device's clock.
  payment_confirmed_at  timestamptz,
  accepted_at           timestamptz,
  eta_minutes           integer,
  promised_ready_at     timestamptz,
  refund_requested_at   timestamptz,
  checkout_notified_at  timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  revision              integer NOT NULL DEFAULT 0,

  CONSTRAINT restaurant_order_restaurant_fkey FOREIGN KEY (hotel_id, restaurant_id)
    REFERENCES platform.restaurant (hotel_id, restaurant_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_order_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_order_session_fkey FOREIGN KEY (hotel_id, guest_session_id)
    REFERENCES platform.guest_session (hotel_id, guest_session_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_order_identity_uq UNIQUE (hotel_id, order_id),
  -- The target the child rows carry their stay through, so the guest
  -- confinement policy can be a column comparison rather than a subquery and
  -- the denormalised stay cannot drift from the order's.
  CONSTRAINT restaurant_order_stay_uq UNIQUE (order_id, stay_id),
  CONSTRAINT restaurant_order_no_uq UNIQUE (order_no),
  CONSTRAINT restaurant_order_no_shape CHECK (order_no ~ '^[A-Z0-9]{8,12}$'::text),
  CONSTRAINT restaurant_order_total_positive CHECK (total_amount_mnt > 0),
  CONSTRAINT restaurant_order_phone_shape
    CHECK (contact_phone_snapshot ~ '^\+976[0-9]{8}$'::text),
  CONSTRAINT restaurant_order_note_bounded
    CHECK (guest_note IS NULL OR length(guest_note) BETWEEN 1 AND 500),

  -- The seven axes.
  CONSTRAINT restaurant_order_order_state_known
    CHECK (order_state = ANY (ARRAY['PENDING_PAYMENT'::text, 'CONFIRMED'::text,
                                    'CANCELLED'::text, 'COMPLETED'::text])),
  CONSTRAINT restaurant_order_fulfillment_state_known
    CHECK (fulfillment_state = ANY (ARRAY['NOT_STARTED'::text, 'AWAITING_ACCEPTANCE'::text,
                                          'ACCEPTED'::text, 'PREPARING'::text, 'READY'::text,
                                          'OUT_FOR_DELIVERY'::text, 'DELIVERED_TO_ROOM'::text,
                                          'HANDED_TO_RECEPTION'::text, 'PICKED_UP_BY_GUEST'::text,
                                          'CANCELLED'::text])),
  CONSTRAINT restaurant_order_payment_state_known
    CHECK (payment_state = ANY (ARRAY['PENDING'::text, 'PAID'::text, 'FAILED'::text,
                                      'EXPIRED'::text])),
  CONSTRAINT restaurant_order_refund_policy_known
    CHECK (refund_policy = ANY (ARRAY['NONE'::text, 'MANDATORY'::text, 'DISCRETIONARY'::text])),
  CONSTRAINT restaurant_order_refund_request_known
    CHECK (refund_request_state = ANY (ARRAY['NONE'::text, 'OPEN'::text, 'APPROVED'::text,
                                             'REJECTED'::text, 'RESOLVED'::text])),
  CONSTRAINT restaurant_order_refund_state_known
    CHECK (refund_state = ANY (ARRAY['NONE'::text, 'PENDING'::text, 'REFUNDED'::text,
                                     'FAILED'::text])),
  CONSTRAINT restaurant_order_handoff_known
    CHECK (handoff_mode = ANY (ARRAY['ROOM'::text, 'RECEPTION'::text, 'GUEST_PICKUP'::text,
                                     'REFUND_REQUEST'::text])),

  -- How the order axis follows from the other two. doc 08 §10 states each of
  -- these in a sentence; they are constraints so no path can produce a row that
  -- says two things at once.
  CONSTRAINT restaurant_order_pending_shape
    CHECK (payment_state <> 'PENDING'::text
           OR (order_state = 'PENDING_PAYMENT'::text
               AND fulfillment_state = 'NOT_STARTED'::text)),
  CONSTRAINT restaurant_order_pending_payment_shape
    CHECK (order_state <> 'PENDING_PAYMENT'::text
           OR payment_state = ANY (ARRAY['PENDING'::text, 'FAILED'::text])),
  CONSTRAINT restaurant_order_cancelled_shape
    CHECK ((fulfillment_state = 'CANCELLED'::text) = (order_state = 'CANCELLED'::text)),
  CONSTRAINT restaurant_order_completed_shape
    CHECK ((fulfillment_state = ANY (ARRAY['DELIVERED_TO_ROOM'::text,
                                           'HANDED_TO_RECEPTION'::text,
                                           'PICKED_UP_BY_GUEST'::text]))
           = (order_state = 'COMPLETED'::text)),
  CONSTRAINT restaurant_order_confirmed_shape
    CHECK (order_state <> 'CONFIRMED'::text
           OR (payment_state = 'PAID'::text
               AND fulfillment_state = ANY (ARRAY['AWAITING_ACCEPTANCE'::text, 'ACCEPTED'::text,
                                                  'PREPARING'::text, 'READY'::text,
                                                  'OUT_FOR_DELIVERY'::text]))),
  -- doc 08 §19: the terminal handoff event has to match the mode it was
  -- handed over under. Reception's *choice* is not itself terminal.
  CONSTRAINT restaurant_order_handoff_matches
    CHECK ((fulfillment_state <> 'HANDED_TO_RECEPTION'::text OR handoff_mode = 'RECEPTION'::text)
           AND (fulfillment_state <> 'PICKED_UP_BY_GUEST'::text
                OR handoff_mode = 'GUEST_PICKUP'::text)
           AND (fulfillment_state <> 'DELIVERED_TO_ROOM'::text OR handoff_mode = 'ROOM'::text)),

  -- The refund axes, and how they relate. Money never taken is never owed back.
  CONSTRAINT restaurant_order_refund_axes_agree
    CHECK ((refund_policy = 'NONE'::text) = (refund_request_state = 'NONE'::text)),
  CONSTRAINT restaurant_order_refund_needs_payment
    CHECK (refund_policy = 'NONE'::text OR payment_state = 'PAID'::text),
  -- `REST-DEC-002`: a mandatory policy is approved in the same transaction that
  -- creates it; the restaurant is never offered a refusal.
  CONSTRAINT restaurant_order_mandatory_is_approved
    CHECK (refund_policy <> 'MANDATORY'::text
           OR refund_request_state = ANY (ARRAY['APPROVED'::text, 'RESOLVED'::text])),
  CONSTRAINT restaurant_order_refund_needs_approval
    CHECK (refund_state = 'NONE'::text
           OR refund_request_state = ANY (ARRAY['APPROVED'::text, 'RESOLVED'::text])),
  CONSTRAINT restaurant_order_resolved_is_refunded
    CHECK ((refund_state = 'REFUNDED'::text) = (refund_request_state = 'RESOLVED'::text)),
  CONSTRAINT restaurant_order_reject_reason_shape
    CHECK ((refund_request_state = 'REJECTED'::text) = (reject_reason IS NOT NULL)),
  CONSTRAINT restaurant_order_reject_reason_known
    CHECK (reject_reason IS NULL
           OR reject_reason = ANY (ARRAY['PREPARATION_STARTED'::text, 'FOOD_READY'::text,
                                         'OUT_FOR_DELIVERY'::text, 'HANDED_OVER'::text])),
  CONSTRAINT restaurant_order_refund_reason_shape
    CHECK ((refund_policy = 'NONE'::text) = (refund_reason IS NULL)),
  CONSTRAINT restaurant_order_refund_reason_known
    CHECK (refund_reason IS NULL
           OR refund_reason = ANY (ARRAY['PRE_ACCEPT_SLA'::text, 'RESTAURANT_CANCELLED'::text,
                                         'PAID_AFTER_INVOICE_EXPIRY'::text,
                                         'RESTAURANT_INACTIVE_AT_PAYMENT'::text,
                                         'RESTAURANT_OR_ITEM_INACTIVE_AT_PAYMENT'::text,
                                         'GUEST_REQUEST'::text, 'CHECKOUT_REFUND_REQUEST'::text,
                                         'ETA_OVERDUE'::text])),
  CONSTRAINT restaurant_order_request_time_shape
    CHECK ((refund_request_state = 'NONE'::text) = (refund_requested_at IS NULL)),

  -- `RC-DEC-030`: the acceptance clock starts at the server-confirmed payment.
  CONSTRAINT restaurant_order_payment_time_shape
    CHECK ((payment_state = 'PAID'::text) = (payment_confirmed_at IS NOT NULL)),
  -- `REST-DEC-003`: accepting means choosing one of four ETAs, and the promise
  -- is exactly that many minutes after the acceptance. Arithmetic, not intent.
  CONSTRAINT restaurant_order_accept_shape
    CHECK ((accepted_at IS NULL) = (eta_minutes IS NULL)
           AND (accepted_at IS NULL) = (promised_ready_at IS NULL)),
  CONSTRAINT restaurant_order_eta_known
    CHECK (eta_minutes IS NULL OR eta_minutes = ANY (ARRAY[15, 30, 45, 60])),
  CONSTRAINT restaurant_order_promise_derived
    CHECK (promised_ready_at IS NULL
           OR promised_ready_at = accepted_at + (eta_minutes * interval '1 minute')),
  CONSTRAINT restaurant_order_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX restaurant_order_queue_idx
  ON platform.restaurant_order (restaurant_id, fulfillment_state, payment_confirmed_at);
--> statement-breakpoint
CREATE INDEX restaurant_order_stay_idx ON platform.restaurant_order (stay_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX restaurant_order_session_idx
  ON platform.restaurant_order (guest_session_id, created_at DESC);
--> statement-breakpoint
-- The unresolved refund requests `RC-DEC-031` escalates and eventually pauses a
-- link for.
CREATE INDEX restaurant_order_open_refund_idx
  ON platform.restaurant_order (hotel_id, restaurant_id, refund_requested_at)
  WHERE refund_request_state = ANY (ARRAY['OPEN'::text, 'APPROVED'::text]);
--> statement-breakpoint

-- doc 08 §11: name, unit price and quantity as they were when the order was
-- confirmed. A later price change is a later price.
CREATE TABLE platform.restaurant_order_item (
  order_item_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id       uuid NOT NULL,
  order_id       uuid NOT NULL,
  -- Carried so the guest confinement policy is a column comparison; the
  -- composite foreign key below is what keeps it equal to the order's.
  stay_id        uuid NOT NULL,
  item_id        uuid NOT NULL,
  name_snapshot  text NOT NULL,
  unit_price_mnt bigint NOT NULL,
  quantity       integer NOT NULL,
  line_total_mnt bigint NOT NULL,
  CONSTRAINT restaurant_order_item_order_fkey FOREIGN KEY (hotel_id, order_id)
    REFERENCES platform.restaurant_order (hotel_id, order_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_order_item_stay_fkey FOREIGN KEY (order_id, stay_id)
    REFERENCES platform.restaurant_order (order_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_order_item_uq UNIQUE (order_id, item_id),
  CONSTRAINT restaurant_order_item_name_bounded CHECK (length(name_snapshot) BETWEEN 1 AND 200),
  CONSTRAINT restaurant_order_item_price_positive CHECK (unit_price_mnt > 0),
  CONSTRAINT restaurant_order_item_quantity_bounded CHECK (quantity BETWEEN 1 AND 50),
  CONSTRAINT restaurant_order_item_line_total
    CHECK (line_total_mnt = unit_price_mnt * quantity)
);
--> statement-breakpoint

CREATE TABLE platform.restaurant_order_event (
  event_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id     uuid NOT NULL,
  order_id     uuid NOT NULL,
  stay_id      uuid NOT NULL,
  axis         text NOT NULL,
  event_type   text NOT NULL,
  from_state   text,
  to_state     text,
  actor_ref    text NOT NULL,
  reason       text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_order_event_order_fkey FOREIGN KEY (hotel_id, order_id)
    REFERENCES platform.restaurant_order (hotel_id, order_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_order_event_stay_fkey FOREIGN KEY (order_id, stay_id)
    REFERENCES platform.restaurant_order (order_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_order_event_axis_known
    CHECK (axis = ANY (ARRAY['order'::text, 'fulfillment'::text, 'payment'::text,
                             'refund_policy'::text, 'refund_request'::text, 'refund'::text,
                             'handoff'::text])),
  CONSTRAINT restaurant_order_event_type_bounded CHECK (length(event_type) BETWEEN 1 AND 80),
  CONSTRAINT restaurant_order_event_actor_bounded CHECK (length(actor_ref) BETWEEN 1 AND 120),
  CONSTRAINT restaurant_order_event_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE INDEX restaurant_order_event_order_idx
  ON platform.restaurant_order_event (order_id, occurred_at);
--> statement-breakpoint

-- doc 08 §11: one invoice per attempt, on the restaurant's own merchant, and
-- an expiry that `RC-DEC-023` will not let outlive the day's ordering close.
-- The close is snapshotted here rather than joined to, so the rule is a
-- property of this row.
CREATE TABLE platform.restaurant_payment_attempt (
  attempt_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id            uuid NOT NULL,
  order_id            uuid NOT NULL,
  restaurant_id       uuid NOT NULL,
  provider            text NOT NULL DEFAULT 'QPAY',
  provider_invoice_id text,
  provider_payment_id text,
  amount_mnt          bigint NOT NULL,
  state               text NOT NULL DEFAULT 'ACTIVE',
  ordering_closes_at  timestamptz NOT NULL,
  expires_at          timestamptz NOT NULL,
  settled_at          timestamptz,
  settled_reason      text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT restaurant_payment_attempt_order_fkey FOREIGN KEY (hotel_id, order_id)
    REFERENCES platform.restaurant_order (hotel_id, order_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_payment_attempt_provider_known CHECK (provider = 'QPAY'::text),
  CONSTRAINT restaurant_payment_attempt_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'PAID'::text, 'FAILED'::text, 'EXPIRED'::text])),
  CONSTRAINT restaurant_payment_attempt_amount_positive CHECK (amount_mnt > 0),
  -- `RC-DEC-023`, as a constraint: an invoice cannot be written that outlives
  -- the day's ordering close.
  CONSTRAINT restaurant_payment_attempt_within_close
    CHECK (expires_at <= ordering_closes_at),
  CONSTRAINT restaurant_payment_attempt_settled_shape
    CHECK ((state = 'ACTIVE'::text) = (settled_at IS NULL)),
  CONSTRAINT restaurant_payment_attempt_reason_bounded
    CHECK (settled_reason IS NULL OR length(settled_reason) BETWEEN 1 AND 200),
  CONSTRAINT restaurant_payment_attempt_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
-- One live invoice per order, and one captured transaction per attempt.
CREATE UNIQUE INDEX restaurant_payment_attempt_one_active_uq
  ON platform.restaurant_payment_attempt (order_id)
  WHERE state = 'ACTIVE'::text;
--> statement-breakpoint
CREATE UNIQUE INDEX restaurant_payment_attempt_invoice_uq
  ON platform.restaurant_payment_attempt (provider, provider_invoice_id)
  WHERE provider_invoice_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX restaurant_payment_attempt_payment_uq
  ON platform.restaurant_payment_attempt (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
--> statement-breakpoint

-- The refund the restaurant executes on its own merchant (`RC-DEC-024`). The
-- platform records it and moves no money: there is no payable, no batch and no
-- settlement anywhere in this migration.
CREATE TABLE platform.restaurant_refund (
  refund_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id            uuid NOT NULL,
  order_id            uuid NOT NULL,
  restaurant_id       uuid NOT NULL,
  amount_mnt          bigint NOT NULL,
  state               text NOT NULL DEFAULT 'PENDING',
  provider            text NOT NULL DEFAULT 'QPAY',
  provider_payment_id text NOT NULL,
  provider_refund_id  text,
  failure_code        text,
  initiated_by_account_id uuid NOT NULL,
  requested_at        timestamptz NOT NULL DEFAULT now(),
  settled_at          timestamptz,
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT restaurant_refund_order_fkey FOREIGN KEY (hotel_id, order_id)
    REFERENCES platform.restaurant_order (hotel_id, order_id) ON DELETE RESTRICT,
  CONSTRAINT restaurant_refund_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'REFUNDED'::text, 'FAILED'::text])),
  CONSTRAINT restaurant_refund_provider_known CHECK (provider = 'QPAY'::text),
  CONSTRAINT restaurant_refund_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT restaurant_refund_settled_shape
    CHECK ((state = 'PENDING'::text) = (settled_at IS NULL)),
  CONSTRAINT restaurant_refund_completed_has_reference
    CHECK (state <> 'REFUNDED'::text OR provider_refund_id IS NOT NULL),
  CONSTRAINT restaurant_refund_failure_bounded
    CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 80),
  CONSTRAINT restaurant_refund_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX restaurant_refund_provider_uq
  ON platform.restaurant_refund (provider_refund_id)
  WHERE provider_refund_id IS NOT NULL;
--> statement-breakpoint
-- One refund attempt in flight per order; a failure is retried by a new row.
CREATE UNIQUE INDEX restaurant_refund_one_open_uq
  ON platform.restaurant_refund (order_id)
  WHERE state = 'PENDING'::text;
--> statement-breakpoint

-- =====================================================================
-- The guest's own scope
-- =====================================================================

-- A Restaurant guest is not an account: they are whoever holds the room's QR
-- and a one-time code (`RC-DEC-026`). What confines them is the *stay*, and it
-- cannot be `hotel_id` — the menus they have to read are the hotel's.
--
-- Unset it is NULL, so a transaction that has not established a guest session
-- is unconfined by it. That is the one path with no stay yet: redeeming a code,
-- which is what establishes the stay in the first place.
CREATE OR REPLACE FUNCTION platform.current_guest_stay_id() RETURNS uuid
  LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
  SELECT nullif(current_setting('app.guest_stay_id', true), '')::uuid
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.current_guest_stay_id() FROM PUBLIC;
--> statement-breakpoint
-- The maintenance owner is included because the restrictive stay-confinement
-- policies apply to *every* role, the definer's owner among them: a resolver
-- that could not evaluate the policy guarding its own read would fail closed on
-- a permission error rather than on the rule.
GRANT EXECUTE ON FUNCTION platform.current_guest_stay_id()
  TO prsystem_api, prsystem_worker, prsystem_maintenance_fn;
--> statement-breakpoint

-- =====================================================================
-- Guards
-- =====================================================================

CREATE OR REPLACE FUNCTION platform.restaurant_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a restaurant''s identity and owning hotel are immutable'
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
CREATE TRIGGER restaurant_update_guard
  BEFORE UPDATE ON platform.restaurant
  FOR EACH ROW EXECUTE FUNCTION platform.restaurant_guard();
--> statement-breakpoint
CREATE TRIGGER restaurant_no_delete
  BEFORE DELETE ON platform.restaurant
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.hotel_restaurant_link_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.link_id IS DISTINCT FROM OLD.link_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a hotel-restaurant link''s identity is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hotel_restaurant_link_update_guard
  BEFORE UPDATE ON platform.hotel_restaurant_link
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_restaurant_link_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_restaurant_link_no_delete
  BEFORE DELETE ON platform.hotel_restaurant_link
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 08 §10: the axes move forward and never backwards, and one axis moving
-- does not move another. This is where "a late capture reopens nothing" is
-- enforced rather than intended.
CREATE OR REPLACE FUNCTION platform.restaurant_order_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_fulfillment_terminal constant text[] := ARRAY['DELIVERED_TO_ROOM', 'HANDED_TO_RECEPTION',
                                                  'PICKED_UP_BY_GUEST', 'CANCELLED'];
BEGIN
  IF NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.guest_session_id IS DISTINCT FROM OLD.guest_session_id
     OR NEW.order_no IS DISTINCT FROM OLD.order_no
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an order''s identity, stay, room and session are immutable'
      USING ERRCODE = '42501';
  END IF;
  -- doc 08 §11: the price and the number the guest was shown are snapshots.
  IF NEW.total_amount_mnt IS DISTINCT FROM OLD.total_amount_mnt
     OR NEW.contact_phone_snapshot IS DISTINCT FROM OLD.contact_phone_snapshot
     OR NEW.ordering_closes_at IS DISTINCT FROM OLD.ordering_closes_at THEN
    RAISE EXCEPTION 'an order''s price and its snapshots are fixed when it is placed (doc 08 §11)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.payment_state = 'PAID'::text AND NEW.payment_state IS DISTINCT FROM OLD.payment_state THEN
    RAISE EXCEPTION 'a captured payment is never unpaid (doc 08 §10)' USING ERRCODE = '22023';
  END IF;
  IF OLD.fulfillment_state = ANY (v_fulfillment_terminal)
     AND NEW.fulfillment_state IS DISTINCT FROM OLD.fulfillment_state THEN
    RAISE EXCEPTION 'a terminal fulfilment is never reopened (REST-DEC-005)'
      USING ERRCODE = '22023';
  END IF;
  IF OLD.order_state = ANY (ARRAY['CANCELLED'::text, 'COMPLETED'::text])
     AND NEW.order_state IS DISTINCT FROM OLD.order_state THEN
    RAISE EXCEPTION 'a terminal order is never reopened (REST-DEC-005)' USING ERRCODE = '22023';
  END IF;
  IF OLD.refund_state = 'REFUNDED'::text AND NEW.refund_state IS DISTINCT FROM OLD.refund_state THEN
    RAISE EXCEPTION 'a completed refund is never withdrawn (doc 08 §15)' USING ERRCODE = '22023';
  END IF;
  -- `REST-DEC-002`: a mandatory refund is never downgraded to a discretionary
  -- one, so the race cannot be re-run in the restaurant's favour after the fact.
  IF OLD.refund_policy = 'MANDATORY'::text
     AND NEW.refund_policy IS DISTINCT FROM OLD.refund_policy THEN
    RAISE EXCEPTION 'a mandatory refund policy is never downgraded (REST-DEC-002)'
      USING ERRCODE = '22023';
  END IF;
  -- `REST-DEC-003`: the promise is made once. A restaurant that is running late
  -- does not get to move the deadline it is late against.
  IF OLD.accepted_at IS NOT NULL
     AND (NEW.accepted_at IS DISTINCT FROM OLD.accepted_at
          OR NEW.eta_minutes IS DISTINCT FROM OLD.eta_minutes
          OR NEW.promised_ready_at IS DISTINCT FROM OLD.promised_ready_at) THEN
    RAISE EXCEPTION 'an accepted order''s ETA is written once (REST-DEC-003)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.payment_confirmed_at IS NOT NULL
     AND NEW.payment_confirmed_at IS DISTINCT FROM OLD.payment_confirmed_at THEN
    RAISE EXCEPTION 'the confirmed-payment instant every SLA is measured from is written once '
                    '(RC-DEC-030)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.refund_requested_at IS NOT NULL
     AND NEW.refund_requested_at IS DISTINCT FROM OLD.refund_requested_at THEN
    RAISE EXCEPTION 'the instant a refund was requested is written once (RC-DEC-031)'
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
CREATE TRIGGER restaurant_order_update_guard
  BEFORE UPDATE ON platform.restaurant_order
  FOR EACH ROW EXECUTE FUNCTION platform.restaurant_order_guard();
--> statement-breakpoint
CREATE TRIGGER restaurant_order_no_delete
  BEFORE DELETE ON platform.restaurant_order
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER restaurant_order_item_append_only
  BEFORE UPDATE OR DELETE ON platform.restaurant_order_item
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER restaurant_order_event_append_only
  BEFORE UPDATE OR DELETE ON platform.restaurant_order_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.restaurant_payment_attempt_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.ordering_closes_at IS DISTINCT FROM OLD.ordering_closes_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a payment attempt, its amount and its window are immutable (RC-DEC-023)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.provider_invoice_id IS NOT NULL
     AND NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id THEN
    RAISE EXCEPTION 'a provider invoice reference is written once' USING ERRCODE = '42501';
  END IF;
  IF OLD.provider_payment_id IS NOT NULL
     AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
    RAISE EXCEPTION 'a captured transaction is never repointed' USING ERRCODE = '42501';
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
CREATE TRIGGER restaurant_payment_attempt_update_guard
  BEFORE UPDATE ON platform.restaurant_payment_attempt
  FOR EACH ROW EXECUTE FUNCTION platform.restaurant_payment_attempt_guard();
--> statement-breakpoint
CREATE TRIGGER restaurant_payment_attempt_no_delete
  BEFORE DELETE ON platform.restaurant_payment_attempt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.restaurant_refund_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.refund_id IS DISTINCT FROM OLD.refund_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.restaurant_id IS DISTINCT FROM OLD.restaurant_id
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id
     OR NEW.initiated_by_account_id IS DISTINCT FROM OLD.initiated_by_account_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'a refund''s cause, amount and initiator are fixed when it is started '
                    '(doc 08 §15)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'PENDING'::text AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a settled refund attempt is never reopened; a retry is a new attempt'
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
CREATE TRIGGER restaurant_refund_update_guard
  BEFORE UPDATE ON platform.restaurant_refund
  FOR EACH ROW EXECUTE FUNCTION platform.restaurant_refund_guard();
--> statement-breakpoint
CREATE TRIGGER restaurant_refund_no_delete
  BEFORE DELETE ON platform.restaurant_refund
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 08 §7: a one-time code is spent once and a session is closed once.
CREATE OR REPLACE FUNCTION platform.guest_access_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_TABLE_NAME = 'guest_access_code' THEN
    IF NEW.code_id IS DISTINCT FROM OLD.code_id
       OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
       OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
       OR NEW.room_id IS DISTINCT FROM OLD.room_id
       OR NEW.code_hash IS DISTINCT FROM OLD.code_hash
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'a one-time code''s identity and window are immutable (RC-DEC-026)'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.state <> 'PENDING'::text AND NEW.state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION 'a spent or revoked code is never revived' USING ERRCODE = '22023';
    END IF;
  ELSE
    IF NEW.guest_session_id IS DISTINCT FROM OLD.guest_session_id
       OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
       OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
       OR NEW.room_id IS DISTINCT FROM OLD.room_id
       OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.code_id IS DISTINCT FROM OLD.code_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
      RAISE EXCEPTION 'a guest session''s identity, stay and room are immutable (RC-DEC-026)'
        USING ERRCODE = '42501';
    END IF;
    IF OLD.state <> 'ACTIVE'::text AND NEW.state IS DISTINCT FROM OLD.state THEN
      RAISE EXCEPTION 'a closed guest session is never reopened' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guest_access_code_update_guard
  BEFORE UPDATE ON platform.guest_access_code
  FOR EACH ROW EXECUTE FUNCTION platform.guest_access_guard();
--> statement-breakpoint
CREATE TRIGGER guest_access_code_no_delete
  BEFORE DELETE ON platform.guest_access_code
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER guest_session_update_guard
  BEFORE UPDATE ON platform.guest_session
  FOR EACH ROW EXECUTE FUNCTION platform.guest_access_guard();
--> statement-breakpoint
CREATE TRIGGER guest_session_no_delete
  BEFORE DELETE ON platform.guest_session
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.stay_guest_access_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id THEN
    RAISE EXCEPTION 'a stay''s guest-access counter belongs to one stay and one room'
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
CREATE TRIGGER stay_guest_access_update_guard
  BEFORE UPDATE ON platform.stay_guest_access
  FOR EACH ROW EXECUTE FUNCTION platform.stay_guest_access_guard();
--> statement-breakpoint
CREATE TRIGGER stay_guest_access_no_delete
  BEFORE DELETE ON platform.stay_guest_access
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.room_access_token_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.room_access_id IS DISTINCT FROM OLD.room_access_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.token_version IS DISTINCT FROM OLD.token_version
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at THEN
    RAISE EXCEPTION 'a room QR token is replaced by a new one, never edited (RC-DEC-026)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'ROTATED'::text AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a rotated QR token is never made live again' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER room_access_token_update_guard
  BEFORE UPDATE ON platform.room_access_token
  FOR EACH ROW EXECUTE FUNCTION platform.room_access_token_guard();
--> statement-breakpoint
CREATE TRIGGER room_access_token_no_delete
  BEFORE DELETE ON platform.room_access_token
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Row level security
-- =====================================================================

-- Every table here is the hotel's, so every one carries `tenant_isolation`.

ALTER TABLE platform.restaurant ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.restaurant FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.restaurant
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.hotel_restaurant_link ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_restaurant_link FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_restaurant_link
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.restaurant_schedule ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.restaurant_schedule FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.restaurant_schedule
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.restaurant_schedule_override ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.restaurant_schedule_override FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.restaurant_schedule_override
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.restaurant_menu_category ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.restaurant_menu_category FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.restaurant_menu_category
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.restaurant_menu_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.restaurant_menu_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.restaurant_menu_item
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.room_access_token ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_access_token FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.room_access_token
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.stay_guest_access ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_guest_access FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.stay_guest_access
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.guest_access_code ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.guest_access_code FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.guest_access_code
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.guest_session ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.guest_session FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.guest_session
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.restaurant_order ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.restaurant_order FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.restaurant_order
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.restaurant_order_item ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.restaurant_order_item FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.restaurant_order_item
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.restaurant_order_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.restaurant_order_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.restaurant_order_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.restaurant_payment_attempt ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.restaurant_payment_attempt FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.restaurant_payment_attempt
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.restaurant_refund ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.restaurant_refund FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.restaurant_refund
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint


-- doc 08 §7: and a guest sees their own stay, not the hotel's.
--
-- `RESTRICTIVE`, because a permissive policy added alongside `tenant_isolation`
-- would widen rather than narrow: permissive policies are OR-ed. This one is
-- AND-ed with the tenant predicate, so a transaction carrying a guest stay is
-- confined to it and every other transaction is unaffected — the restriction is
-- vacuous when the setting is unset, which is exactly the state of the one path
-- that has no stay yet.

CREATE POLICY guest_stay_confinement ON platform.restaurant_order
  AS RESTRICTIVE
  USING (platform.current_guest_stay_id() IS NULL
         OR stay_id = platform.current_guest_stay_id())
  WITH CHECK (platform.current_guest_stay_id() IS NULL
              OR stay_id = platform.current_guest_stay_id());
--> statement-breakpoint

CREATE POLICY guest_stay_confinement ON platform.restaurant_order_item
  AS RESTRICTIVE
  USING (platform.current_guest_stay_id() IS NULL
         OR stay_id = platform.current_guest_stay_id())
  WITH CHECK (platform.current_guest_stay_id() IS NULL
              OR stay_id = platform.current_guest_stay_id());
--> statement-breakpoint

CREATE POLICY guest_stay_confinement ON platform.restaurant_order_event
  AS RESTRICTIVE
  USING (platform.current_guest_stay_id() IS NULL
         OR stay_id = platform.current_guest_stay_id())
  WITH CHECK (platform.current_guest_stay_id() IS NULL
              OR stay_id = platform.current_guest_stay_id());
--> statement-breakpoint

CREATE POLICY guest_stay_confinement ON platform.guest_access_code
  AS RESTRICTIVE
  USING (platform.current_guest_stay_id() IS NULL
         OR stay_id = platform.current_guest_stay_id())
  WITH CHECK (platform.current_guest_stay_id() IS NULL
              OR stay_id = platform.current_guest_stay_id());
--> statement-breakpoint

CREATE POLICY guest_stay_confinement ON platform.guest_session
  AS RESTRICTIVE
  USING (platform.current_guest_stay_id() IS NULL
         OR stay_id = platform.current_guest_stay_id())
  WITH CHECK (platform.current_guest_stay_id() IS NULL
              OR stay_id = platform.current_guest_stay_id());
--> statement-breakpoint

-- =====================================================================
-- Grants
-- =====================================================================

-- The API runs the whole restaurant lifecycle. The worker holds the two sweeps
-- this phase needs — invoice expiry and the refund-request SLA — so it settles
-- what exists and creates nothing except history.
GRANT SELECT, INSERT, UPDATE ON platform.restaurant                  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT                 ON platform.restaurant                  TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.hotel_restaurant_link       TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.hotel_restaurant_link       TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.restaurant_schedule         TO prsystem_api;
--> statement-breakpoint
GRANT SELECT                 ON platform.restaurant_schedule         TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.restaurant_schedule_override TO prsystem_api;
--> statement-breakpoint
GRANT SELECT                 ON platform.restaurant_schedule_override TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.restaurant_menu_category    TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.restaurant_menu_item        TO prsystem_api;
--> statement-breakpoint
GRANT SELECT                 ON platform.restaurant_menu_item        TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.room_access_token           TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.stay_guest_access           TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.stay_guest_access           TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.guest_access_code           TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.guest_access_code           TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.guest_session               TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.guest_session               TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.restaurant_order            TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.restaurant_order            TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.restaurant_order_item       TO prsystem_api;
--> statement-breakpoint
GRANT SELECT                 ON platform.restaurant_order_item       TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.restaurant_order_event      TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.restaurant_payment_attempt  TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.restaurant_payment_attempt  TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.restaurant_refund           TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON platform.restaurant_refund           TO prsystem_worker;
--> statement-breakpoint

-- =====================================================================
-- Resolving a QR token, and finding work across hotels
-- =====================================================================

-- A guest scans a QR and presents a token. The hotel and room it names are the
-- server's to resolve — the same narrow way Phase 13 resolves the hotel of a
-- category and Phase 14 the hotel of an invoice: a `SECURITY DEFINER` function
-- owned by the login-less role, answering two identifiers and nothing else.
--
-- It answers only for a *live* token, so a rotated QR resolves to nothing at
-- all and `RC-DEC-026`'s "the old QR is void immediately" is a property of this
-- function rather than of the code that calls it.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform.room_of_access_token(p_token_hash text)
  RETURNS TABLE (hotel_id uuid, room_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT t.hotel_id, t.room_id
    FROM platform.room_access_token t
   WHERE t.token_hash = p_token_hash
     AND t.state = 'ACTIVE'::text
$$;
--> statement-breakpoint
ALTER FUNCTION platform.room_of_access_token(text) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

-- A guest presents a session token and names no tenant, so the hotel the token
-- belongs to has to be resolved before any scoped read is possible at all.
-- Narrow on purpose: it answers with the hotel and nothing else, only for a
-- live session, and the service re-reads the row inside that hotel's own scope
-- afterwards rather than trusting this lookup.
CREATE OR REPLACE FUNCTION platform.hotel_of_guest_session(p_token_hash text)
  RETURNS TABLE (hotel_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.hotel_id
    FROM platform.guest_session s
   WHERE s.token_hash = p_token_hash
     AND s.state = 'ACTIVE'::text
$$;
--> statement-breakpoint
ALTER FUNCTION platform.hotel_of_guest_session(text) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

-- The two sweeps. Both have the shape Phase 13's expiry sweep established: find
-- the work across every hotel, decide nothing, and settle each row in its own
-- hotel's scope on its own lock.
CREATE OR REPLACE FUNCTION platform.lapsed_restaurant_invoices(
  p_limit integer,
  p_now   timestamptz DEFAULT NULL
) RETURNS TABLE (order_id uuid, hotel_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.order_id, a.hotel_id
    FROM platform.restaurant_payment_attempt a
   WHERE a.state = 'ACTIVE'::text
     AND a.expires_at <= coalesce(p_now, pg_catalog.now())
   ORDER BY a.expires_at
   LIMIT p_limit
$$;
--> statement-breakpoint
ALTER FUNCTION platform.lapsed_restaurant_invoices(integer, timestamptz)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform.unresolved_refund_requests(
  p_limit integer,
  p_now   timestamptz DEFAULT NULL
) RETURNS TABLE (order_id uuid, hotel_id uuid, restaurant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT o.order_id, o.hotel_id, o.restaurant_id
    FROM platform.restaurant_order o
   WHERE o.refund_request_state = ANY (ARRAY['OPEN'::text, 'APPROVED'::text])
     AND o.refund_requested_at IS NOT NULL
     AND o.refund_requested_at <= coalesce(p_now, pg_catalog.now())
   ORDER BY o.refund_requested_at
   LIMIT p_limit
$$;
--> statement-breakpoint
ALTER FUNCTION platform.unresolved_refund_requests(integer, timestamptz)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  platform.room_of_access_token(text),
  platform.hotel_of_guest_session(text),
  platform.lapsed_restaurant_invoices(integer, timestamptz),
  platform.unresolved_refund_requests(integer, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.room_of_access_token(text) TO prsystem_api;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.hotel_of_guest_session(text) TO prsystem_api;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.lapsed_restaurant_invoices(integer, timestamptz)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.unresolved_refund_requests(integer, timestamptz)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT ON platform.room_access_token, platform.guest_session,
                platform.restaurant_payment_attempt, platform.restaurant_order
  TO prsystem_maintenance_fn;
--> statement-breakpoint

-- RLS applies to the definer's owner too, so each resolver gets exactly the
-- narrow read it needs and nothing wider: a live QR token, an invoice whose
-- window has closed, and a refund request still waiting.
CREATE POLICY qr_resolution_read ON platform.room_access_token
  FOR SELECT TO prsystem_maintenance_fn
  USING (state = 'ACTIVE'::text);
--> statement-breakpoint
CREATE POLICY session_resolution_read ON platform.guest_session
  FOR SELECT TO prsystem_maintenance_fn
  USING (state = 'ACTIVE'::text);
--> statement-breakpoint
CREATE POLICY invoice_sweep_read ON platform.restaurant_payment_attempt
  FOR SELECT TO prsystem_maintenance_fn
  USING (state = 'ACTIVE'::text);
--> statement-breakpoint
CREATE POLICY refund_sla_read ON platform.restaurant_order
  FOR SELECT TO prsystem_maintenance_fn
  USING (refund_request_state = ANY (ARRAY['OPEN'::text, 'APPROVED'::text]));
--> statement-breakpoint

-- A provider callback names an invoice and no tenant, and the restaurant's
-- merchant is its own — so the hotel a callback belongs to is resolved the same
-- narrow way Phase 14 resolves a booking's.
--
-- It answers for an attempt in *any* state, because doc 08 §14 is precisely
-- about the callbacks that arrive after the invoice has expired: those must be
-- recognisable in order to be refundable.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION platform.restaurant_attempt_of_invoice(p_invoice_id text)
  RETURNS TABLE (attempt_id uuid, hotel_id uuid, order_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.attempt_id, a.hotel_id, a.order_id
    FROM platform.restaurant_payment_attempt a
   WHERE a.provider_invoice_id = p_invoice_id
$$;
--> statement-breakpoint
ALTER FUNCTION platform.restaurant_attempt_of_invoice(text) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.restaurant_attempt_of_invoice(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.restaurant_attempt_of_invoice(text) TO prsystem_api;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
--> statement-breakpoint
CREATE POLICY callback_dispatch_read ON platform.restaurant_payment_attempt
  FOR SELECT TO prsystem_maintenance_fn
  USING (provider_invoice_id IS NOT NULL);
--> statement-breakpoint
