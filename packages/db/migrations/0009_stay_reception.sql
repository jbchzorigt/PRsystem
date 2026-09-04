-- Availability, guest identity, reception, and stay: the Reception shift a
-- check-in needs, the room's cleaning state and its append-only history, the
-- stay with its immutable times and snapshots, the primary guest's identity
-- (encrypted, with a keyed lookup token), the minibar price book captured at
-- check-in, the active-stay actual-time correction, the overdue conflict of a
-- confirmed booking, and the stay history.
--
-- Five structural rules run through this migration.
--
-- **The times of a stay are written once.** `actual_check_in_at`,
-- `check_in_recorded_at` and `planned_checkout_at` are set by the confirming
-- transaction and refused any later change by trigger, whoever issues the
-- statement: `STAY-DEC-009`'s recorded time, `STAY-DEC-011`'s direct-overwrite
-- guard and `STAY-DEC-012`'s complete lock are one trigger, not three
-- conventions. The only later change to a stay's timeline is an approved
-- correction row (`STAY-DEC-010`), from which the effective actual start is
-- derived; nothing rewrites the original.
--
-- **One live stay per room.** A partial unique index over the non-terminal
-- states is what two Receptions confirming the same room at once run into; the
-- service's row lock and interval check are the first line, the index the
-- last (`STAY-DEC-008`, doc 05 §6).
--
-- **Readiness is proven from history, never assumed.** `room_cleaning_event`
-- is append-only with a server timestamp, so a backdated check-in can prove
-- the room was `CLEAN` at the chosen instant or be refused (`STAY-DEC-009`,
-- doc 05 §19.2).
--
-- **An identifier is stored encrypted and looked up by a keyed token.** Raw
-- registration numbers and passport numbers never land in a plain column; the
-- token is namespaced by identity type and country (`RC-DEC-044`, CLAUDE.md
-- §8, ADR-0020).
--
-- **A price book is a snapshot.** The minibar prices a stay is charged are the
-- rows captured at `check_in_recorded_at`; no role holds `UPDATE` or `DELETE`
-- on them and a trigger refuses both (`PRICE-DEC-001`).
--
-- docs 05 (`STAY-DEC-001`, `-003`, `-007`…`-014`), 02 (`RC-DEC-007`, `-012`,
-- `-013`, `-014`, `-015`, `-017`, `-033`, `-044`), 25 (`PRICE-DEC-001`), 06,
-- 12 §§5–6, 13 §8, 18 §3; ADR-0007 (money), ADR-0009 (append-only), ADR-0011
-- (revision/CAS), ADR-0017 (RLS + roles), ADR-0018 (audit), ADR-0020 (PII).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- =====================================================================
-- The Reception shift a check-in is confirmed in
-- =====================================================================

-- doc 05 §19.1: no current open shift, no check-in. The operational shift is
-- created here in its minimal form — who opened it and when, whether it is
-- still open — because the check-in bound needs it; the cash count, handover
-- and financial review of doc 03 are Phase 11's and extend this row.
CREATE TABLE platform.reception_shift (
  shift_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id             uuid NOT NULL,
  state                text NOT NULL DEFAULT 'OPEN',
  opened_by_account_id uuid NOT NULL,
  opened_at            timestamptz NOT NULL DEFAULT now(),
  closed_by_account_id uuid,
  closed_at            timestamptz,
  revision             integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT reception_shift_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT reception_shift_hotel_scope_uq UNIQUE (hotel_id, shift_id),
  CONSTRAINT reception_shift_state_known
    CHECK (state = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])),
  CONSTRAINT reception_shift_closed_shape
    CHECK ((state = 'CLOSED'::text) = (closed_at IS NOT NULL AND closed_by_account_id IS NOT NULL)),
  CONSTRAINT reception_shift_closed_after_opened
    CHECK (closed_at IS NULL OR closed_at >= opened_at)
);
--> statement-breakpoint
-- One open shift per hotel: the shift a check-in belongs to is never ambiguous.
CREATE UNIQUE INDEX reception_shift_one_open_uq
  ON platform.reception_shift (hotel_id) WHERE state = 'OPEN'::text;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.reception_shift_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.shift_id IS DISTINCT FROM OLD.shift_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.opened_by_account_id IS DISTINCT FROM OLD.opened_by_account_id
     OR NEW.opened_at IS DISTINCT FROM OLD.opened_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a shift identity and its opening are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  IF OLD.state = 'CLOSED' THEN
    RAISE EXCEPTION 'a closed shift is never reopened' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER reception_shift_update_guard
  BEFORE UPDATE ON platform.reception_shift
  FOR EACH ROW EXECUTE FUNCTION platform.reception_shift_guard();
--> statement-breakpoint
CREATE TRIGGER reception_shift_no_delete
  BEFORE DELETE ON platform.reception_shift
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Cleaning state: the current axis and its append-only history
-- =====================================================================

-- doc 06 §4, doc 04 §6: `Цэвэрлэгээ шаардлагатай → Цэвэрлэж байгаа → Цэвэр`.
-- A room with no row has never been marked clean and is not ready. The row is
-- the current axis; `room_cleaning_event` is what a backdated check-in proves
-- readiness from (doc 05 §19.2).
CREATE TABLE platform.room_cleaning_state (
  room_id            uuid PRIMARY KEY,
  hotel_id           uuid NOT NULL,
  state              text NOT NULL,
  changed_at         timestamptz NOT NULL DEFAULT now(),
  changed_by_account_id uuid,
  revision           integer NOT NULL DEFAULT 0,
  CONSTRAINT room_cleaning_state_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT room_cleaning_state_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT room_cleaning_state_known
    CHECK (state = ANY (ARRAY['CLEAN'::text, 'NEEDS_CLEANING'::text, 'CLEANING'::text]))
);
--> statement-breakpoint

CREATE TABLE platform.room_cleaning_event (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  room_id          uuid NOT NULL,
  from_state       text,
  to_state         text NOT NULL,
  stay_id          uuid,
  actor_account_id uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT room_cleaning_event_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT room_cleaning_event_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT room_cleaning_event_to_state_known
    CHECK (to_state = ANY (ARRAY['CLEAN'::text, 'NEEDS_CLEANING'::text, 'CLEANING'::text])),
  CONSTRAINT room_cleaning_event_from_state_known
    CHECK (from_state IS NULL
           OR from_state = ANY (ARRAY['CLEAN'::text, 'NEEDS_CLEANING'::text, 'CLEANING'::text]))
);
--> statement-breakpoint
CREATE INDEX room_cleaning_event_room_idx
  ON platform.room_cleaning_event (hotel_id, room_id, occurred_at);
--> statement-breakpoint
CREATE TRIGGER room_cleaning_event_append_only
  BEFORE UPDATE OR DELETE ON platform.room_cleaning_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER room_cleaning_event_no_truncate
  BEFORE TRUNCATE ON platform.room_cleaning_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The stay
-- =====================================================================

-- doc 05 §§2–3, §§9–12, §§17–24; doc 02 §§3.12–3.15. Planned and actual
-- times are separate columns, and the state of the stay is separate from the
-- room's cleaning and minibar axes (`RC-DEC-015`). Duration is integer
-- half-hour units and minutes, never a float hour (`STAY-DEC-014`).
CREATE TABLE platform.stay (
  stay_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  room_id                 uuid NOT NULL,
  category_id             uuid NOT NULL,
  source                  text NOT NULL,
  booking_ref             uuid,
  stay_type               text NOT NULL,
  state                   text NOT NULL DEFAULT 'ACTIVE',
  -- `STAY-DEC-009`: the Reception-confirmed arrival, at most 120 minutes before
  -- the immutable server time the confirmation was recorded at.
  actual_check_in_at      timestamptz NOT NULL,
  check_in_recorded_at    timestamptz NOT NULL,
  planned_checkout_at     timestamptz NOT NULL,
  half_hour_units         integer,
  duration_minutes        integer,
  night_count             integer,
  fixed_checkout_minute   integer,
  cleaning_buffer_minutes integer NOT NULL,
  rate_snapshot_id        uuid NOT NULL,
  unit_rate_mnt           bigint NOT NULL,
  room_charge_mnt         bigint NOT NULL,
  pricing_config_version  integer NOT NULL,
  -- doc 05 §5: a walk-in stay carries a deposit, a confirmed online booking
  -- does not — a fact of the source, stated as a constraint.
  deposit_required        boolean NOT NULL,
  shift_id                uuid NOT NULL,
  checked_in_by_account_id uuid NOT NULL,
  backdate_minutes        integer NOT NULL DEFAULT 0,
  backdate_reason_code    text,
  backdate_note           text,
  minibar_applicable      boolean NOT NULL DEFAULT false,
  actual_checkout_at      timestamptz,
  checkout_recorded_by_account_id uuid,
  revision                integer NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT stay_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT stay_category_fkey FOREIGN KEY (hotel_id, category_id)
    REFERENCES platform.room_category (hotel_id, category_id) ON DELETE RESTRICT,
  CONSTRAINT stay_rate_snapshot_fkey FOREIGN KEY (rate_snapshot_id)
    REFERENCES platform.stay_rate_snapshot (snapshot_id) ON DELETE RESTRICT,
  CONSTRAINT stay_shift_fkey FOREIGN KEY (hotel_id, shift_id)
    REFERENCES platform.reception_shift (hotel_id, shift_id) ON DELETE RESTRICT,
  CONSTRAINT stay_hotel_scope_uq UNIQUE (hotel_id, stay_id),
  CONSTRAINT stay_rate_snapshot_uq UNIQUE (rate_snapshot_id),
  CONSTRAINT stay_source_known
    CHECK (source = ANY (ARRAY['WALK_IN'::text, 'ONLINE'::text])),
  CONSTRAINT stay_source_shape
    CHECK ((source = 'ONLINE'::text) = (booking_ref IS NOT NULL)),
  CONSTRAINT stay_deposit_by_source
    CHECK (deposit_required = (source = 'WALK_IN'::text)),
  CONSTRAINT stay_type_known
    CHECK (stay_type = ANY (ARRAY['HOURLY'::text, 'NIGHTLY'::text])),
  CONSTRAINT stay_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'CHECKOUT_IN_PROGRESS'::text, 'COMPLETED'::text])),
  -- `STAY-DEC-014`: integer half-hour units, minutes derived, at least one.
  CONSTRAINT stay_hourly_shape
    CHECK (stay_type <> 'HOURLY'::text
           OR (half_hour_units >= 1 AND duration_minutes = half_hour_units * 30
               AND night_count IS NULL AND fixed_checkout_minute IS NULL)),
  -- `STAY-DEC-007`: a positive whole night count against a snapshotted fixed
  -- check-out time.
  CONSTRAINT stay_nightly_shape
    CHECK (stay_type <> 'NIGHTLY'::text
           OR (night_count >= 1 AND fixed_checkout_minute BETWEEN 0 AND 1439
               AND half_hour_units IS NULL AND duration_minutes IS NULL)),
  CONSTRAINT stay_buffer_range CHECK (cleaning_buffer_minutes BETWEEN 0 AND 1440),
  CONSTRAINT stay_rate_non_negative CHECK (unit_rate_mnt >= 0),
  CONSTRAINT stay_charge_non_negative CHECK (room_charge_mnt >= 0),
  CONSTRAINT stay_version_positive CHECK (pricing_config_version >= 1),
  CONSTRAINT stay_actual_not_after_recorded CHECK (actual_check_in_at <= check_in_recorded_at),
  CONSTRAINT stay_planned_after_actual CHECK (planned_checkout_at > actual_check_in_at),
  -- `STAY-DEC-009`: at most 120 minutes, and a reason whenever there is one.
  CONSTRAINT stay_backdate_range CHECK (backdate_minutes BETWEEN 0 AND 120),
  CONSTRAINT stay_backdate_reason
    CHECK ((backdate_minutes > 0) = (backdate_reason_code IS NOT NULL)),
  CONSTRAINT stay_backdate_reason_bounded
    CHECK (backdate_reason_code IS NULL OR length(backdate_reason_code) BETWEEN 1 AND 60),
  CONSTRAINT stay_backdate_note_bounded
    CHECK (backdate_note IS NULL OR length(backdate_note) BETWEEN 1 AND 500),
  CONSTRAINT stay_completed_shape
    CHECK ((state = 'COMPLETED'::text) = (actual_checkout_at IS NOT NULL)),
  CONSTRAINT stay_checkout_recorded_shape
    CHECK ((actual_checkout_at IS NULL) = (checkout_recorded_by_account_id IS NULL)),
  CONSTRAINT stay_checkout_after_check_in
    CHECK (actual_checkout_at IS NULL OR actual_checkout_at >= actual_check_in_at)
);
--> statement-breakpoint
-- One live stay per room (`STAY-DEC-013`: an occupied room takes no second
-- check-in, whatever two Receptions saw on their screens).
CREATE UNIQUE INDEX stay_one_live_per_room_uq
  ON platform.stay (hotel_id, room_id) WHERE state <> 'COMPLETED'::text;
--> statement-breakpoint
CREATE INDEX stay_room_timeline_idx
  ON platform.stay (hotel_id, room_id, planned_checkout_at);
--> statement-breakpoint
CREATE INDEX stay_booking_ref_idx
  ON platform.stay (hotel_id, booking_ref) WHERE booking_ref IS NOT NULL;
--> statement-breakpoint

-- The times, the snapshot and the identity of a stay are written once. The
-- state moves forward only. This is `STAY-DEC-011` and `STAY-DEC-012` as a
-- database fact: no backend write, whoever issues it, overwrites a planned
-- checkout, an actual check-in or the recorded time.
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
      OR (OLD.state = 'CHECKOUT_IN_PROGRESS' AND NEW.state = 'COMPLETED')
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
CREATE TRIGGER stay_update_guard
  BEFORE UPDATE ON platform.stay
  FOR EACH ROW EXECUTE FUNCTION platform.stay_update_guard();
--> statement-breakpoint
CREATE TRIGGER stay_no_delete
  BEFORE DELETE ON platform.stay
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The primary guest of a stay
-- =====================================================================

-- doc 02 §3.1, doc 12 §§5–6, doc 13 §8.2 (`RC-DEC-033`, `RC-DEC-044`). One
-- primary guest per stay; a correction is a new revision row, never an edit.
-- The raw identifier is envelope-encrypted with the row as authenticated
-- data; exact lookup uses the keyed, namespaced token. Nothing here is a
-- plaintext registration or passport number.
CREATE TABLE platform.stay_guest (
  guest_record_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                 uuid NOT NULL,
  stay_id                  uuid NOT NULL,
  revision_no              integer NOT NULL DEFAULT 1,
  is_current               boolean NOT NULL DEFAULT true,
  identity_type            text NOT NULL,
  family_name              text NOT NULL,
  given_name               text NOT NULL,
  date_of_birth            date NOT NULL,
  nationality              text NOT NULL,
  provenance               text NOT NULL,
  assurance                text NOT NULL,
  identifier_ciphertext    bytea,
  identifier_wrapped_dek   bytea,
  identifier_key_version   text,
  lookup_token             text,
  lookup_key_version       text,
  lookup_namespace         text,
  document_country         text,
  document_expires_on      date,
  document_type            text,
  document_authority       text,
  no_document_reason       text,
  no_document_note         text,
  age_at_check_in          integer,
  guardian_name            text,
  guardian_phone           text,
  guardian_relationship    text,
  police_match_eligibility text NOT NULL,
  correction_reason        text,
  recorded_by_account_id   uuid,
  recorded_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_guest_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT stay_guest_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT stay_guest_revision_uq UNIQUE (stay_id, revision_no),
  CONSTRAINT stay_guest_revision_positive CHECK (revision_no >= 1),
  CONSTRAINT stay_guest_identity_type_known
    CHECK (identity_type = ANY (ARRAY['MN_REG_NO'::text, 'FOREIGN_PASSPORT'::text,
                                      'OTHER_GOV_ID'::text, 'NO_DOCUMENT'::text])),
  CONSTRAINT stay_guest_provenance_known
    CHECK (provenance = ANY (ARRAY['XYP_VERIFIED'::text, 'MANUAL'::text])),
  CONSTRAINT stay_guest_assurance_known
    CHECK (assurance = ANY (ARRAY['DOCUMENT'::text, 'LOW_ASSURANCE'::text])),
  CONSTRAINT stay_guest_eligibility_known
    CHECK (police_match_eligibility = ANY (ARRAY['ELIGIBLE_EXACT_RD'::text,
                                                 'NOT_ELIGIBLE_EXACT_RD'::text])),
  CONSTRAINT stay_guest_names_bounded
    CHECK (length(family_name) BETWEEN 1 AND 120 AND length(given_name) BETWEEN 1 AND 120),
  CONSTRAINT stay_guest_nationality_shape CHECK (nationality ~ '^[A-Z]{2}$'),
  -- XYP verifies a Mongolian registration number and nothing else (`RC-DEC-007`).
  CONSTRAINT stay_guest_xyp_only_for_reg_no
    CHECK (provenance <> 'XYP_VERIFIED'::text OR identity_type = 'MN_REG_NO'::text),
  -- Only a structurally valid registration number is matched (doc 13 §8.2).
  CONSTRAINT stay_guest_eligibility_by_type
    CHECK (police_match_eligibility <> 'ELIGIBLE_EXACT_RD'::text
           OR identity_type = 'MN_REG_NO'::text),
  -- The encrypted identifier and its token travel together, or not at all.
  CONSTRAINT stay_guest_identifier_shape
    CHECK ((identifier_ciphertext IS NULL) = (identifier_wrapped_dek IS NULL)
           AND (identifier_ciphertext IS NULL) = (identifier_key_version IS NULL)
           AND (identifier_ciphertext IS NULL) = (lookup_token IS NULL)
           AND (lookup_token IS NULL) = (lookup_key_version IS NULL)
           AND (lookup_token IS NULL) = (lookup_namespace IS NULL)),
  CONSTRAINT stay_guest_reg_no_shape
    CHECK (identity_type <> 'MN_REG_NO'::text
           OR (identifier_ciphertext IS NOT NULL AND document_country = 'MN'::text
               AND assurance = 'DOCUMENT'::text)),
  CONSTRAINT stay_guest_passport_shape
    CHECK (identity_type <> 'FOREIGN_PASSPORT'::text
           OR (identifier_ciphertext IS NOT NULL AND document_country IS NOT NULL
               AND document_expires_on IS NOT NULL AND assurance = 'DOCUMENT'::text)),
  CONSTRAINT stay_guest_other_id_shape
    CHECK (identity_type <> 'OTHER_GOV_ID'::text
           OR (identifier_ciphertext IS NOT NULL AND document_type IS NOT NULL
               AND document_country IS NOT NULL AND document_authority IS NOT NULL
               AND assurance = 'DOCUMENT'::text)),
  CONSTRAINT stay_guest_no_document_shape
    CHECK (identity_type <> 'NO_DOCUMENT'::text
           OR (identifier_ciphertext IS NULL AND no_document_reason IS NOT NULL
               AND assurance = 'LOW_ASSURANCE'::text)),
  CONSTRAINT stay_guest_document_country_shape
    CHECK (document_country IS NULL OR document_country ~ '^[A-Z]{2}$'),
  CONSTRAINT stay_guest_document_type_bounded
    CHECK (document_type IS NULL OR length(document_type) BETWEEN 1 AND 60),
  CONSTRAINT stay_guest_document_authority_bounded
    CHECK (document_authority IS NULL OR length(document_authority) BETWEEN 1 AND 120),
  CONSTRAINT stay_guest_no_document_reason_bounded
    CHECK (no_document_reason IS NULL OR length(no_document_reason) BETWEEN 1 AND 300),
  CONSTRAINT stay_guest_no_document_note_bounded
    CHECK (no_document_note IS NULL OR length(no_document_note) BETWEEN 1 AND 500),
  CONSTRAINT stay_guest_age_range CHECK (age_at_check_in IS NULL OR age_at_check_in BETWEEN 0 AND 130),
  -- doc 02 §3.1: a primary guest under 18 has a responsible adult recorded.
  CONSTRAINT stay_guest_guardian_when_minor
    CHECK (age_at_check_in IS NULL OR age_at_check_in >= 18
           OR (guardian_name IS NOT NULL AND guardian_phone IS NOT NULL
               AND guardian_relationship IS NOT NULL)),
  CONSTRAINT stay_guest_guardian_bounded
    CHECK ((guardian_name IS NULL OR length(guardian_name) BETWEEN 1 AND 120)
           AND (guardian_phone IS NULL OR length(guardian_phone) BETWEEN 4 AND 30)
           AND (guardian_relationship IS NULL OR length(guardian_relationship) BETWEEN 1 AND 60)),
  CONSTRAINT stay_guest_correction_reason_shape
    CHECK ((revision_no = 1) = (correction_reason IS NULL)),
  CONSTRAINT stay_guest_correction_reason_bounded
    CHECK (correction_reason IS NULL OR length(correction_reason) BETWEEN 1 AND 300)
);
--> statement-breakpoint
-- Exactly one current revision per stay (`RC-DEC-033`).
CREATE UNIQUE INDEX stay_guest_current_uq
  ON platform.stay_guest (stay_id) WHERE is_current IS TRUE;
--> statement-breakpoint
CREATE INDEX stay_guest_lookup_idx
  ON platform.stay_guest (hotel_id, lookup_token) WHERE lookup_token IS NOT NULL;
--> statement-breakpoint

-- A revision is written once. The single permitted update is the flip that
-- retires it when the next revision is recorded.
CREATE OR REPLACE FUNCTION platform.stay_guest_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NOT (OLD.is_current IS TRUE AND NEW.is_current IS FALSE) THEN
    RAISE EXCEPTION 'a guest identity revision is append-only; correct it with a new revision'
      USING ERRCODE = '42501';
  END IF;
  IF to_jsonb(NEW) - 'is_current' IS DISTINCT FROM to_jsonb(OLD) - 'is_current' THEN
    RAISE EXCEPTION 'a guest identity revision is append-only; correct it with a new revision'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stay_guest_update_guard
  BEFORE UPDATE ON platform.stay_guest
  FOR EACH ROW EXECUTE FUNCTION platform.stay_guest_guard();
--> statement-breakpoint
CREATE TRIGGER stay_guest_no_delete
  BEFORE DELETE ON platform.stay_guest
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stay_guest_no_truncate
  BEFORE TRUNCATE ON platform.stay_guest
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The minibar price book captured at check-in
-- =====================================================================

-- doc 25 §3 (`PRICE-DEC-001`): the exact template and version the room's
-- current configuration named at `check_in_recorded_at`, and every product of
-- that version with the selling price in force — including those the room
-- held none of. Written in the confirming transaction, never again.
CREATE TABLE platform.stay_minibar_snapshot (
  stay_id     uuid PRIMARY KEY,
  hotel_id    uuid NOT NULL,
  room_id     uuid NOT NULL,
  template_id uuid NOT NULL,
  version_id  uuid NOT NULL,
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_minibar_snapshot_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT stay_minibar_snapshot_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT stay_minibar_snapshot_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT stay_minibar_snapshot_version_fkey FOREIGN KEY (hotel_id, template_id, version_id)
    REFERENCES platform.minibar_template_version (hotel_id, template_id, version_id)
    ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE INDEX stay_minibar_snapshot_version_idx
  ON platform.stay_minibar_snapshot (hotel_id, version_id);
--> statement-breakpoint

CREATE TABLE platform.stay_minibar_price (
  stay_id           uuid NOT NULL,
  product_id        uuid NOT NULL,
  hotel_id          uuid NOT NULL,
  product_name      text NOT NULL,
  product_category  text,
  product_unit      text,
  selling_price_mnt bigint NOT NULL,
  target_quantity   integer NOT NULL,
  opening_quantity  integer NOT NULL,
  CONSTRAINT stay_minibar_price_pkey PRIMARY KEY (stay_id, product_id),
  CONSTRAINT stay_minibar_price_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT stay_minibar_price_snapshot_fkey FOREIGN KEY (stay_id)
    REFERENCES platform.stay_minibar_snapshot (stay_id) ON DELETE RESTRICT,
  CONSTRAINT stay_minibar_price_product_fkey FOREIGN KEY (hotel_id, product_id)
    REFERENCES platform.minibar_product (hotel_id, product_id) ON DELETE RESTRICT,
  CONSTRAINT stay_minibar_price_non_negative CHECK (selling_price_mnt >= 0),
  CONSTRAINT stay_minibar_price_target_positive CHECK (target_quantity >= 1),
  CONSTRAINT stay_minibar_price_opening_non_negative CHECK (opening_quantity >= 0),
  CONSTRAINT stay_minibar_price_name_bounded CHECK (length(product_name) BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE TRIGGER stay_minibar_snapshot_append_only
  BEFORE UPDATE OR DELETE ON platform.stay_minibar_snapshot
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stay_minibar_snapshot_no_truncate
  BEFORE TRUNCATE ON platform.stay_minibar_snapshot
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stay_minibar_price_append_only
  BEFORE UPDATE OR DELETE ON platform.stay_minibar_price
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stay_minibar_price_no_truncate
  BEFORE TRUNCATE ON platform.stay_minibar_price
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The active-stay actual-time correction
-- =====================================================================

-- doc 05 §20 (`STAY-DEC-010`): a Reception request, a Manager decision, and an
-- effective actual start derived from the latest approved row. The bound is
-- fixed at request time on the original recorded time, so it never slides.
CREATE TABLE platform.stay_time_correction (
  correction_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                 uuid NOT NULL,
  stay_id                  uuid NOT NULL,
  state                    text NOT NULL DEFAULT 'PENDING',
  previous_effective_at    timestamptz NOT NULL,
  corrected_actual_check_in_at timestamptz NOT NULL,
  earliest_allowed_at      timestamptz NOT NULL,
  latest_allowed_at        timestamptz NOT NULL,
  reason                   text NOT NULL,
  requested_by_account_id  uuid NOT NULL,
  requested_at             timestamptz NOT NULL DEFAULT now(),
  decided_by_account_id    uuid,
  decided_at               timestamptz,
  decision_reason          text,
  self_approved            boolean NOT NULL DEFAULT false,
  revision                 integer NOT NULL DEFAULT 0,
  CONSTRAINT stay_time_correction_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT stay_time_correction_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT stay_time_correction_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])),
  CONSTRAINT stay_time_correction_bound_shape
    CHECK (earliest_allowed_at <= corrected_actual_check_in_at
           AND corrected_actual_check_in_at <= latest_allowed_at),
  CONSTRAINT stay_time_correction_reason_bounded CHECK (length(reason) BETWEEN 1 AND 300),
  CONSTRAINT stay_time_correction_decision_shape
    CHECK ((state = 'PENDING'::text) = (decided_at IS NULL)
           AND (decided_at IS NULL) = (decided_by_account_id IS NULL)),
  CONSTRAINT stay_time_correction_decision_reason_bounded
    CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 1 AND 300),
  -- `self_approved` names the one case doc 05 §20.1 allows and audits.
  CONSTRAINT stay_time_correction_self_approved_shape
    CHECK (self_approved IS FALSE
           OR (decided_by_account_id IS NOT NULL AND decided_by_account_id = requested_by_account_id))
);
--> statement-breakpoint
-- One pending correction per stay (doc 05 §20.1).
CREATE UNIQUE INDEX stay_time_correction_one_pending_uq
  ON platform.stay_time_correction (stay_id) WHERE state = 'PENDING'::text;
--> statement-breakpoint
CREATE INDEX stay_time_correction_stay_idx
  ON platform.stay_time_correction (hotel_id, stay_id, decided_at);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.stay_time_correction_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.correction_id IS DISTINCT FROM OLD.correction_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.stay_id IS DISTINCT FROM OLD.stay_id
     OR NEW.previous_effective_at IS DISTINCT FROM OLD.previous_effective_at
     OR NEW.corrected_actual_check_in_at IS DISTINCT FROM OLD.corrected_actual_check_in_at
     OR NEW.earliest_allowed_at IS DISTINCT FROM OLD.earliest_allowed_at
     OR NEW.latest_allowed_at IS DISTINCT FROM OLD.latest_allowed_at
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by_account_id IS DISTINCT FROM OLD.requested_by_account_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'a correction request is immutable; decide it or leave it'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'a decided correction is immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.state NOT IN ('APPROVED', 'REJECTED') THEN
    RAISE EXCEPTION 'illegal correction transition % -> %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER stay_time_correction_update_guard
  BEFORE UPDATE ON platform.stay_time_correction
  FOR EACH ROW EXECUTE FUNCTION platform.stay_time_correction_guard();
--> statement-breakpoint
CREATE TRIGGER stay_time_correction_no_delete
  BEFORE DELETE ON platform.stay_time_correction
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The overdue conflict of a confirmed booking
-- =====================================================================

-- doc 05 §23 (`STAY-DEC-013`): one open conflict per booking, opened when the
-- next booking's cleaning-preparation boundary is reached while the room's
-- stay has no actual checkout and the category has no other eligible room;
-- closed by exactly one of four terminal outcomes. The booking itself is
-- Phase 13's relation; the conflict names it by reference and carries the
-- facts it was opened on.
CREATE TABLE platform.booking_fulfillment_conflict (
  conflict_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id               uuid NOT NULL,
  booking_ref            uuid NOT NULL,
  category_id            uuid NOT NULL,
  room_id                uuid NOT NULL,
  overdue_stay_id        uuid NOT NULL,
  planned_checkin_at     timestamptz NOT NULL,
  cleaning_buffer_minutes integer NOT NULL,
  state                  text NOT NULL DEFAULT 'OPEN',
  assigned_room_id       uuid,
  resolved_by_account_id uuid,
  resolved_at            timestamptz,
  reason                 text,
  self_approved          boolean NOT NULL DEFAULT false,
  detected_at            timestamptz NOT NULL DEFAULT now(),
  revision               integer NOT NULL DEFAULT 0,
  CONSTRAINT booking_fulfillment_conflict_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT booking_fulfillment_conflict_category_fkey FOREIGN KEY (hotel_id, category_id)
    REFERENCES platform.room_category (hotel_id, category_id) ON DELETE RESTRICT,
  CONSTRAINT booking_fulfillment_conflict_room_fkey FOREIGN KEY (hotel_id, room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT booking_fulfillment_conflict_stay_fkey FOREIGN KEY (hotel_id, overdue_stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT booking_fulfillment_conflict_assigned_room_fkey FOREIGN KEY (hotel_id, assigned_room_id)
    REFERENCES platform.room (hotel_id, room_id) ON DELETE RESTRICT,
  CONSTRAINT booking_fulfillment_conflict_state_known
    CHECK (state = ANY (ARRAY['OPEN'::text, 'RESOLVED_READY'::text, 'RESOLVED_REASSIGNED'::text,
                              'RESOLVED_HIGHER_CATEGORY'::text, 'CANCELLED_HOTEL'::text])),
  CONSTRAINT booking_fulfillment_conflict_buffer_range
    CHECK (cleaning_buffer_minutes BETWEEN 0 AND 1440),
  CONSTRAINT booking_fulfillment_conflict_resolution_shape
    CHECK ((state = 'OPEN'::text) = (resolved_at IS NULL)),
  CONSTRAINT booking_fulfillment_conflict_assignment_shape
    CHECK ((state = ANY (ARRAY['RESOLVED_REASSIGNED'::text, 'RESOLVED_HIGHER_CATEGORY'::text]))
           = (assigned_room_id IS NOT NULL)),
  CONSTRAINT booking_fulfillment_conflict_cancel_has_reason
    CHECK (state <> 'CANCELLED_HOTEL'::text OR reason IS NOT NULL),
  CONSTRAINT booking_fulfillment_conflict_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE UNIQUE INDEX booking_fulfillment_conflict_one_open_uq
  ON platform.booking_fulfillment_conflict (hotel_id, booking_ref) WHERE state = 'OPEN'::text;
--> statement-breakpoint
CREATE INDEX booking_fulfillment_conflict_room_idx
  ON platform.booking_fulfillment_conflict (hotel_id, room_id, state);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.booking_fulfillment_conflict_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.conflict_id IS DISTINCT FROM OLD.conflict_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.booking_ref IS DISTINCT FROM OLD.booking_ref
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.room_id IS DISTINCT FROM OLD.room_id
     OR NEW.overdue_stay_id IS DISTINCT FROM OLD.overdue_stay_id
     OR NEW.planned_checkin_at IS DISTINCT FROM OLD.planned_checkin_at
     OR NEW.cleaning_buffer_minutes IS DISTINCT FROM OLD.cleaning_buffer_minutes
     OR NEW.detected_at IS DISTINCT FROM OLD.detected_at THEN
    RAISE EXCEPTION 'a conflict and the facts it was opened on are immutable' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  IF OLD.state <> 'OPEN' THEN
    RAISE EXCEPTION 'a resolved conflict is terminal' USING ERRCODE = '42501';
  END IF;
  IF NEW.state = 'OPEN' THEN
    RAISE EXCEPTION 'an open conflict changes only by resolving' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER booking_fulfillment_conflict_update_guard
  BEFORE UPDATE ON platform.booking_fulfillment_conflict
  FOR EACH ROW EXECUTE FUNCTION platform.booking_fulfillment_conflict_guard();
--> statement-breakpoint
CREATE TRIGGER booking_fulfillment_conflict_no_delete
  BEFORE DELETE ON platform.booking_fulfillment_conflict
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Stay history
-- =====================================================================

CREATE TABLE platform.stay_event (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id         uuid NOT NULL,
  stay_id          uuid NOT NULL,
  event_type       text NOT NULL,
  from_state       text,
  to_state         text,
  reason           text,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_account_id uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stay_event_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT stay_event_stay_fkey FOREIGN KEY (hotel_id, stay_id)
    REFERENCES platform.stay (hotel_id, stay_id) ON DELETE RESTRICT,
  CONSTRAINT stay_event_type_bounded CHECK (length(event_type) BETWEEN 1 AND 60),
  CONSTRAINT stay_event_reason_bounded CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 500),
  CONSTRAINT stay_event_payload_has_no_denied_key
    CHECK (NOT platform.contains_denied_key(payload))
);
--> statement-breakpoint
CREATE INDEX stay_event_stay_idx
  ON platform.stay_event (hotel_id, stay_id, occurred_at);
--> statement-breakpoint
CREATE TRIGGER stay_event_append_only
  BEFORE UPDATE OR DELETE ON platform.stay_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER stay_event_no_truncate
  BEFORE TRUNCATE ON platform.stay_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Row Level Security
-- =====================================================================

ALTER TABLE platform.reception_shift              ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.reception_shift              FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_cleaning_state          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_cleaning_state          FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_cleaning_event          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.room_cleaning_event          FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay                         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay                         FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_guest                   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_guest                   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_minibar_snapshot        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_minibar_snapshot        FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_minibar_price           ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_minibar_price           FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_time_correction         ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_time_correction         FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.booking_fulfillment_conflict ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.booking_fulfillment_conflict FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_event                   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.stay_event                   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

CREATE POLICY tenant_isolation ON platform.reception_shift
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.room_cleaning_state
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.room_cleaning_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.stay
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.stay_guest
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.stay_minibar_snapshot
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.stay_minibar_price
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.stay_time_correction
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.booking_fulfillment_conflict
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.stay_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Grants
-- =====================================================================

-- The API writes what a Reception, a Manager or a Cleaner does; nothing it
-- holds lets it rewrite a time, a price book or a history row. The worker
-- reads: the stay history and the guest's keyed token are what Phase 18's
-- matching and Phase 17's registry export consume. No Police login touches a
-- hotel relation (doc 13 §3).
GRANT SELECT, INSERT, UPDATE ON platform.reception_shift              TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.room_cleaning_state          TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.room_cleaning_event          TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.stay                         TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.stay_guest                   TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.stay_minibar_snapshot        TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.stay_minibar_price           TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.stay_time_correction         TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.booking_fulfillment_conflict TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.stay_event                   TO prsystem_api;
--> statement-breakpoint
GRANT SELECT ON platform.reception_shift              TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.room_cleaning_state          TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.room_cleaning_event          TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.stay                         TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.stay_guest                   TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.stay_minibar_snapshot        TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.stay_minibar_price           TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.stay_time_correction         TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.booking_fulfillment_conflict TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.stay_event                   TO prsystem_worker;
