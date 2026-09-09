-- =====================================================================
-- 0019 — Police monitoring: wanted persons, cases, matches and alerts
--
-- The first migration to put rows in the `police` schema, which has existed
-- and been empty since the kernel precisely so this separation would be a
-- database fact before it was a feature (ADR-0017 §6). Five rules shape what
-- follows.
--
-- **A person, a case and a match are three different things** (`POL-DEC-017`).
-- A Wanted Person is an identity and holds no `FOUND` or `CLOSED` state; a
-- Wanted Case is one legal basis with its own lifecycle, and one person may
-- have several; a Match is a `stay × person` detection event, unique on that
-- pair. `MatchCaseLink` joins a match to the cases that were active when it was
-- detected, and to any that activate while the stay still is — append-only, so
-- a case closing later never erases why an officer was called.
--
-- **Matching is exact, or it does not happen** (`POL-DEC-017`, doc 13 §8.1).
-- The comparison is between two keyed lookup tokens of the same namespace and
-- the same key version, derived from a structurally valid normalized
-- `MN_REG_NO`. There is no fuzzy path in this schema for a name, a birth date
-- or an address to travel down, because none exists.
--
-- **Nobody owns a match** (`POL-DEC-016`, `POL-DEC-020`). There is no
-- `responsible_user_id`, no assignee and no transfer — not as a nullable
-- column, not as a state. What the rows carry are immutable event facts:
-- who created, who approved, who first acknowledged, who confirmed a Found.
-- `originating_unit_ref` and the notified groups are routing, and routing is
-- not ownership.
--
-- **Two people, compared on account ids** (`POL-DEC-018`, `POL-DEC-019`,
-- `POL-DEC-015`). A manual identity revision, a Found correction and a False
-- Match each need a second person, and each table CHECKs that the decider is
-- not the requester. A UI that hides a button is not this; a constraint is.
--
-- **What has no approved configuration does not run.** The escalation timer and
-- the Police Admin historical check-in search are both governed by written ЦЕГ
-- policy that does not exist yet (doc 13 §4.1, §10.1). Each is a configuration
-- row rather than a constant, and its absence is what disables the feature —
-- so production cannot acquire either by deploying code.
-- =====================================================================

-- =====================================================================
-- The wanted person, and the immutable revisions of their identity
-- =====================================================================

-- doc 13 §6.3: an identity aggregate and nothing else. The raw registration
-- number is never here; two keyed tokens are.
--
-- `identity_token` is this schema's own key, derived under the Police HMAC
-- scope: it makes a person unique and answers an officer's exact search, and a
-- leak of it cannot be joined to anything the hotel side holds. `match_token`
-- is derived under the platform scope — it is the value a check-in event
-- carries, and exact matching is the comparison of the two. They are different
-- values of the same number under different keys, which is what lets the two
-- indexes exist without becoming one.
CREATE TABLE police.wanted_person (
  person_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_namespace    text NOT NULL,
  identity_token        text NOT NULL,
  identity_key_version  text NOT NULL,
  match_namespace       text NOT NULL,
  match_token           text NOT NULL,
  match_key_version     text NOT NULL,
  created_by_account_id uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  revision              integer NOT NULL DEFAULT 0,
  CONSTRAINT wanted_person_identity_uq UNIQUE (identity_namespace, identity_token),
  CONSTRAINT wanted_person_namespace_known
    CHECK (identity_namespace = 'registration_number:MN'::text
           AND match_namespace = 'registration_number:MN'::text),
  CONSTRAINT wanted_person_token_shape
    CHECK (identity_token ~ '^[0-9a-f]{64}$'::text AND match_token ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT wanted_person_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
-- The matching index. A check-in event presents a token, a namespace and a key
-- version, and all three must agree: a token derived under a rotated key is a
-- different value, and answering it as a match would be a false one.
CREATE INDEX wanted_person_match_idx
  ON police.wanted_person (match_namespace, match_token, match_key_version);
--> statement-breakpoint

-- doc 13 §6.3 and §7: identity is versioned, and a version is never edited.
-- A `MANUAL` revision starts `PENDING_APPROVAL` and reaches `APPROVED` only
-- through a different account (`POL-DEC-018`); an `XYP_VERIFIED` one is
-- approved by the source and has no decider at all.
CREATE TABLE police.wanted_identity_revision (
  revision_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id               uuid NOT NULL,
  revision_no             integer NOT NULL,
  is_current              boolean NOT NULL DEFAULT false,
  family_name             text NOT NULL,
  parent_name             text NOT NULL,
  given_name              text NOT NULL,
  date_of_birth           date NOT NULL,
  home_address            text,
  -- doc 13 §11.2 charts wanted people by the district of their address, which
  -- is a different axis from the district a match is routed by.
  home_district           text,
  identifier_ciphertext   bytea NOT NULL,
  identifier_wrapped_dek  bytea NOT NULL,
  identifier_key_version  text NOT NULL,
  provenance              text NOT NULL,
  approval_state          text NOT NULL,
  created_by_account_id   uuid NOT NULL,
  decided_by_account_id   uuid,
  decided_at              timestamptz,
  decision_reason         text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wanted_identity_revision_person_fkey FOREIGN KEY (person_id)
    REFERENCES police.wanted_person (person_id) ON DELETE RESTRICT,
  CONSTRAINT wanted_identity_revision_no_uq UNIQUE (person_id, revision_no),
  CONSTRAINT wanted_identity_revision_no_positive CHECK (revision_no >= 1),
  CONSTRAINT wanted_identity_provenance_known
    CHECK (provenance = ANY (ARRAY['XYP_VERIFIED'::text, 'MANUAL'::text])),
  CONSTRAINT wanted_identity_approval_known
    CHECK (approval_state = ANY (ARRAY['PENDING_APPROVAL'::text,
                                       'APPROVED'::text,
                                       'REJECTED'::text])),
  CONSTRAINT wanted_identity_names_bounded
    CHECK (length(family_name) BETWEEN 1 AND 100
           AND length(parent_name) BETWEEN 1 AND 100
           AND length(given_name) BETWEEN 1 AND 100),
  CONSTRAINT wanted_identity_address_bounded
    CHECK (home_address IS NULL OR length(home_address) BETWEEN 1 AND 300),
  CONSTRAINT wanted_identity_district_bounded
    CHECK (home_district IS NULL OR length(home_district) BETWEEN 1 AND 100),
  CONSTRAINT wanted_identity_reason_bounded
    CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 5 AND 500),
  -- ХУР answered it, so there is nothing for a second officer to approve.
  CONSTRAINT wanted_identity_verified_shape
    CHECK (provenance <> 'XYP_VERIFIED'::text
           OR (approval_state = 'APPROVED'::text AND decided_by_account_id IS NULL)),
  -- A manual revision is pending until somebody decides it, and a decision
  -- carries its decider and its time together or not at all.
  CONSTRAINT wanted_identity_manual_shape
    CHECK (provenance <> 'MANUAL'::text
           OR (approval_state = 'PENDING_APPROVAL'::text
               AND decided_by_account_id IS NULL AND decided_at IS NULL)
           OR (approval_state <> 'PENDING_APPROVAL'::text
               AND decided_by_account_id IS NOT NULL AND decided_at IS NOT NULL)),
  -- `POL-DEC-018`: the approver is never the creator, and this is where that is
  -- true — not in the service that happens to check it.
  CONSTRAINT wanted_identity_two_person
    CHECK (decided_by_account_id IS NULL OR decided_by_account_id <> created_by_account_id),
  -- Only an approved revision may be the one matching reads.
  CONSTRAINT wanted_identity_current_is_approved
    CHECK (NOT is_current OR approval_state = 'APPROVED'::text)
);
--> statement-breakpoint
CREATE UNIQUE INDEX wanted_identity_current_uq
  ON police.wanted_identity_revision (person_id) WHERE (is_current IS TRUE);
--> statement-breakpoint
-- One pending manual revision per person: a second one would leave two
-- approvers deciding which identity a case matches on.
CREATE UNIQUE INDEX wanted_identity_pending_uq
  ON police.wanted_identity_revision (person_id)
  WHERE approval_state = 'PENDING_APPROVAL'::text;
--> statement-breakpoint
-- Which revision is the current one is `is_current` on the revision itself,
-- with a partial unique index making at most one true per person. A pointer
-- column on the person would be a second place for the same fact to live, and
-- the two could disagree.

-- A revision is a fact about a moment. The only things that may move on it are
-- the approval decision, once, and the `is_current` flag that says which
-- approved revision matching reads — everything else is what was recorded.
CREATE FUNCTION police.wanted_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.revision_no IS DISTINCT FROM OLD.revision_no
     OR NEW.family_name IS DISTINCT FROM OLD.family_name
     OR NEW.parent_name IS DISTINCT FROM OLD.parent_name
     OR NEW.given_name IS DISTINCT FROM OLD.given_name
     OR NEW.date_of_birth IS DISTINCT FROM OLD.date_of_birth
     OR NEW.home_address IS DISTINCT FROM OLD.home_address
     OR NEW.home_district IS DISTINCT FROM OLD.home_district
     OR NEW.identifier_ciphertext IS DISTINCT FROM OLD.identifier_ciphertext
     OR NEW.identifier_wrapped_dek IS DISTINCT FROM OLD.identifier_wrapped_dek
     OR NEW.identifier_key_version IS DISTINCT FROM OLD.identifier_key_version
     OR NEW.provenance IS DISTINCT FROM OLD.provenance
     OR NEW.created_by_account_id IS DISTINCT FROM OLD.created_by_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a wanted identity revision is append-only'
      USING ERRCODE = '22023';
  END IF;
  -- A decision happens once and is not revisited: a rejected revision is
  -- superseded by a new one, never re-approved in place.
  IF OLD.approval_state <> 'PENDING_APPROVAL'::text
     AND NEW.approval_state IS DISTINCT FROM OLD.approval_state THEN
    RAISE EXCEPTION 'a decided identity revision keeps its decision'
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER wanted_identity_guard
  BEFORE UPDATE ON police.wanted_identity_revision
  FOR EACH ROW EXECUTE FUNCTION police.wanted_identity_guard();
--> statement-breakpoint
CREATE TRIGGER wanted_identity_no_delete
  BEFORE DELETE ON police.wanted_identity_revision
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Wanted cases and their lifecycle
-- =====================================================================

-- doc 13 §7: `DRAFT → PENDING_APPROVAL → ACTIVE ↔ SUSPENDED → CLOSED/CANCELLED`.
-- `FOUND` is not here, and never will be: it is a match outcome, and a person
-- being found does not close the case that wanted them (`POL-DEC-013`).
CREATE TABLE police.wanted_case (
  case_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id             uuid NOT NULL,
  reason_text           text NOT NULL,
  crime_category        text NOT NULL,
  -- Organizational routing, never ownership (`POL-DEC-020`).
  owning_unit_ref       text NOT NULL,
  state                 text NOT NULL DEFAULT 'DRAFT',
  activated_at          timestamptz,
  terminal_at           timestamptz,
  created_by_account_id uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  revision              integer NOT NULL DEFAULT 0,
  CONSTRAINT wanted_case_person_fkey FOREIGN KEY (person_id)
    REFERENCES police.wanted_person (person_id) ON DELETE RESTRICT,
  CONSTRAINT wanted_case_identity_uq UNIQUE (person_id, case_id),
  CONSTRAINT wanted_case_state_known
    CHECK (state = ANY (ARRAY['DRAFT'::text, 'PENDING_APPROVAL'::text, 'ACTIVE'::text,
                              'SUSPENDED'::text, 'CLOSED'::text, 'CANCELLED'::text])),
  CONSTRAINT wanted_case_reason_bounded CHECK (length(reason_text) BETWEEN 10 AND 2000),
  CONSTRAINT wanted_case_category_bounded CHECK (length(crime_category) BETWEEN 1 AND 120),
  CONSTRAINT wanted_case_unit_bounded CHECK (length(owning_unit_ref) BETWEEN 1 AND 100),
  -- A case that has ever been active says when, and one that has not cannot
  -- claim to have been.
  CONSTRAINT wanted_case_activation_shape
    CHECK ((state = ANY (ARRAY['DRAFT'::text, 'PENDING_APPROVAL'::text]))
           = (activated_at IS NULL)),
  CONSTRAINT wanted_case_terminal_shape
    CHECK ((state = ANY (ARRAY['CLOSED'::text, 'CANCELLED'::text]))
           = (terminal_at IS NOT NULL)),
  CONSTRAINT wanted_case_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
-- The matching read: the active cases of one person.
CREATE INDEX wanted_case_active_idx
  ON police.wanted_case (person_id) WHERE state = 'ACTIVE'::text;
--> statement-breakpoint
CREATE INDEX wanted_case_state_idx ON police.wanted_case (state, created_at DESC);
--> statement-breakpoint

-- doc 13 §7 and §13.1: every lifecycle move carries a reason, an actor and the
-- pair of states it moved between, and none of them is ever rewritten.
CREATE TABLE police.wanted_case_event (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          uuid NOT NULL,
  from_state       text NOT NULL,
  to_state         text NOT NULL,
  reason           text NOT NULL,
  actor_account_id uuid NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wanted_case_event_case_fkey FOREIGN KEY (case_id)
    REFERENCES police.wanted_case (case_id) ON DELETE RESTRICT,
  CONSTRAINT wanted_case_event_reason_bounded CHECK (length(reason) BETWEEN 5 AND 500),
  CONSTRAINT wanted_case_event_states_differ CHECK (from_state <> to_state)
);
--> statement-breakpoint
CREATE INDEX wanted_case_event_case_idx ON police.wanted_case_event (case_id, occurred_at);
--> statement-breakpoint
CREATE TRIGGER wanted_case_event_append_only
  BEFORE UPDATE OR DELETE ON police.wanted_case_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The match, its case links and its timeline
-- =====================================================================

-- doc 13 §8.4. Three times are kept apart on purpose (`STAY-DEC-009`):
-- `actual_check_in_at` is when the guest says they arrived and may be
-- backdated; `check_in_recorded_at` is when the server accepted the check-in
-- and cannot be; `detected_at` is when this match was found. An approved time
-- correction later moves none of them (doc 13 §8.5).
CREATE TABLE police.police_match (
  match_id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stay_id                         uuid NOT NULL,
  wanted_person_id                uuid NOT NULL,
  -- The hotel snapshot as it was at detection. A later room change is a new
  -- event, never an overwrite of this (doc 13 §8.4).
  hotel_id                        uuid NOT NULL,
  hotel_name                      text NOT NULL,
  hotel_district                  text NOT NULL,
  hotel_address_line              text NOT NULL,
  latitude_micro                  integer,
  longitude_micro                 integer,
  room_number                     text NOT NULL,
  detected_at                     timestamptz NOT NULL,
  check_in_recorded_at            timestamptz NOT NULL,
  actual_check_in_at              timestamptz NOT NULL,
  match_method                    text NOT NULL DEFAULT 'EXACT_REGISTRATION_NUMBER',
  workflow_state                  text NOT NULL DEFAULT 'NEW',
  outcome                         text NOT NULL DEFAULT 'NONE',
  -- An audit fact, not an assignment: whoever confirmed first is recorded and
  -- gains nothing by it (`POL-DEC-011`, `POL-DEC-016`).
  first_acknowledged_by_account_id uuid,
  first_acknowledged_at           timestamptz,
  originating_unit_ref            text NOT NULL,
  -- doc 13 §9.3: a pending False Match is visible and changes nothing yet.
  false_match_review_pending      boolean NOT NULL DEFAULT false,
  revision                        integer NOT NULL DEFAULT 0,
  CONSTRAINT police_match_person_fkey FOREIGN KEY (wanted_person_id)
    REFERENCES police.wanted_person (person_id) ON DELETE RESTRICT,
  -- `POL-DEC-017`: one stay and one person produce one match, forever. A retry,
  -- a duplicated event or a second relay pass cannot make a second alert.
  CONSTRAINT police_match_stay_person_uq UNIQUE (stay_id, wanted_person_id),
  CONSTRAINT police_match_method_known
    CHECK (match_method = 'EXACT_REGISTRATION_NUMBER'::text),
  CONSTRAINT police_match_workflow_known
    CHECK (workflow_state = ANY (ARRAY['NEW'::text, 'ACKNOWLEDGED'::text,
                                       'UNDER_REVIEW'::text, 'RESOLVED'::text])),
  CONSTRAINT police_match_outcome_known
    CHECK (outcome = ANY (ARRAY['NONE'::text, 'FOUND'::text,
                                'FALSE_MATCH'::text, 'LOCATION_STALE'::text])),
  -- An outcome is a resolution: there is no such thing as a `NEW` match that is
  -- already `FOUND`.
  CONSTRAINT police_match_outcome_resolved
    CHECK (outcome = 'NONE'::text OR workflow_state = 'RESOLVED'::text),
  CONSTRAINT police_match_acknowledgement_shape
    CHECK ((first_acknowledged_by_account_id IS NULL) = (first_acknowledged_at IS NULL)),
  CONSTRAINT police_match_new_is_unacknowledged
    CHECK (workflow_state <> 'NEW'::text OR first_acknowledged_by_account_id IS NULL),
  CONSTRAINT police_match_room_bounded CHECK (length(room_number) BETWEEN 1 AND 20),
  CONSTRAINT police_match_position_bounded
    CHECK ((latitude_micro IS NULL) = (longitude_micro IS NULL)
           AND (latitude_micro IS NULL
                OR (latitude_micro BETWEEN -90000000 AND 90000000
                    AND longitude_micro BETWEEN -180000000 AND 180000000))),
  CONSTRAINT police_match_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX police_match_person_idx ON police.police_match (wanted_person_id, detected_at DESC);
--> statement-breakpoint
CREATE INDEX police_match_district_idx
  ON police.police_match (hotel_district, detected_at DESC);
--> statement-breakpoint
CREATE INDEX police_match_open_idx
  ON police.police_match (workflow_state, detected_at DESC)
  WHERE workflow_state <> 'RESOLVED'::text;
--> statement-breakpoint

-- doc 13 §6.3: the cases that were active when the match was detected, and any
-- that activate while the stay still is. Append-only — a case closing later
-- does not erase the link that explains why an officer was called.
CREATE TABLE police.match_case_link (
  link_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id  uuid NOT NULL,
  case_id   uuid NOT NULL,
  linked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_case_link_match_fkey FOREIGN KEY (match_id)
    REFERENCES police.police_match (match_id) ON DELETE RESTRICT,
  CONSTRAINT match_case_link_case_fkey FOREIGN KEY (case_id)
    REFERENCES police.wanted_case (case_id) ON DELETE RESTRICT,
  CONSTRAINT match_case_link_uq UNIQUE (match_id, case_id)
);
--> statement-breakpoint
CREATE TRIGGER match_case_link_append_only
  BEFORE UPDATE OR DELETE ON police.match_case_link
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 13 §13.1: the match's own history. Detection, a linked case, an
-- acknowledgement, a room change, a Found and every correction are events here
-- and are never edited away.
CREATE TABLE police.match_event (
  event_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id         uuid NOT NULL,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_account_id uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_event_match_fkey FOREIGN KEY (match_id)
    REFERENCES police.police_match (match_id) ON DELETE RESTRICT,
  CONSTRAINT match_event_type_known
    CHECK (event_type = ANY (ARRAY['DETECTED'::text, 'CASE_LINKED'::text,
                                   'ALERT_CREATED'::text, 'ACKNOWLEDGED'::text,
                                   'ROOM_UPDATED'::text, 'FOUND_CONFIRMED'::text,
                                   'FOUND_CORRECTION_REQUESTED'::text,
                                   'FOUND_CORRECTION_APPROVED'::text,
                                   'FOUND_CORRECTION_REJECTED'::text,
                                   'FALSE_MATCH_REQUESTED'::text,
                                   'FALSE_MATCH_APPROVED'::text,
                                   'FALSE_MATCH_REJECTED'::text,
                                   'LOCATION_STALE'::text,
                                   'ACTUAL_TIME_CORRECTED'::text])),
  -- CLAUDE.md §8: a match timeline is read by people who may see the match, and
  -- the identifier is not one of the things it needs to carry.
  CONSTRAINT match_event_payload_sanitised CHECK (NOT platform.contains_denied_key(payload))
);
--> statement-breakpoint
CREATE INDEX match_event_match_idx ON police.match_event (match_id, occurred_at);
--> statement-breakpoint
CREATE TRIGGER match_event_append_only
  BEFORE UPDATE OR DELETE ON police.match_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Alerts, their recipients and the escalation nobody has approved yet
-- =====================================================================

-- doc 13 §10.1: which officers a match reaches is decided by the district the
-- *hotel* is in, never by the wanted person's home address. The mapping is a
-- row an approved Police Admin writes, so a district with no approved group
-- routes to the Police Admins and records a routing error rather than silently
-- reaching nobody (`POL-DEC-008`).
CREATE TABLE police.district_alert_group (
  district              text PRIMARY KEY,
  unit_ref              text NOT NULL,
  state                 text NOT NULL DEFAULT 'ACTIVE',
  approved_by_account_id uuid NOT NULL,
  approved_at           timestamptz NOT NULL DEFAULT now(),
  revision              integer NOT NULL DEFAULT 0,
  CONSTRAINT district_alert_group_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])),
  CONSTRAINT district_alert_group_bounded
    CHECK (length(district) BETWEEN 1 AND 100 AND length(unit_ref) BETWEEN 1 AND 100),
  CONSTRAINT district_alert_group_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- One alert per match. Repeat notifications and escalation stages are rows on
-- the delivery table; this is the alert itself, created once with the match.
CREATE TABLE police.match_alert (
  alert_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id         uuid NOT NULL,
  created_at       timestamptz NOT NULL,
  -- doc 13 §10.1: routing that reached no district group is an operational
  -- warning in its own right, not a silent success.
  routing_error    boolean NOT NULL DEFAULT false,
  routed_district  text NOT NULL,
  escalation_stage integer NOT NULL DEFAULT 0,
  escalated_at     timestamptz,
  revision         integer NOT NULL DEFAULT 0,
  CONSTRAINT match_alert_match_fkey FOREIGN KEY (match_id)
    REFERENCES police.police_match (match_id) ON DELETE RESTRICT,
  CONSTRAINT match_alert_match_uq UNIQUE (match_id),
  CONSTRAINT match_alert_stage_shape
    CHECK (escalation_stage >= 0 AND (escalation_stage = 0) = (escalated_at IS NULL)),
  CONSTRAINT match_alert_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- doc 13 §10.2: what a delivery row may keep. The provider's message id, the
-- times, and a **masked** identifier — never the body, never the full number.
CREATE TABLE police.alert_delivery (
  delivery_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_id             uuid NOT NULL,
  recipient_account_id uuid NOT NULL,
  recipient_kind       text NOT NULL,
  channel              text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  delivered_at         timestamptz,
  opened_at            timestamptz,
  provider_message_id  text,
  masked_identifier    text,
  failure_reason       text,
  CONSTRAINT alert_delivery_alert_fkey FOREIGN KEY (alert_id)
    REFERENCES police.match_alert (alert_id) ON DELETE RESTRICT,
  CONSTRAINT alert_delivery_uq UNIQUE (alert_id, recipient_account_id, channel),
  CONSTRAINT alert_delivery_kind_known
    CHECK (recipient_kind = ANY (ARRAY['DISTRICT_OFFICER'::text, 'POLICE_ADMIN'::text,
                                       'DUTY_SUPERVISOR'::text])),
  CONSTRAINT alert_delivery_channel_known
    CHECK (channel = ANY (ARRAY['IN_APP'::text, 'SMS'::text])),
  -- The mask is the shape doc 13 §10.2 allows a log to keep: the last four
  -- digits at most, and never the whole number.
  CONSTRAINT alert_delivery_mask_shape
    CHECK (masked_identifier IS NULL OR masked_identifier ~ '^\*{4,}[0-9]{0,4}$'::text),
  CONSTRAINT alert_delivery_failure_bounded
    CHECK (failure_reason IS NULL OR length(failure_reason) BETWEEN 1 AND 200)
);
--> statement-breakpoint
CREATE INDEX alert_delivery_alert_idx ON police.alert_delivery (alert_id);
--> statement-breakpoint
CREATE INDEX alert_delivery_recipient_idx
  ON police.alert_delivery (recipient_account_id, created_at DESC);
--> statement-breakpoint

-- doc 13 §10.1: the escalation minutes are ЦЕГ's to approve, and until they
-- are approved there is no row here — which is what "not enabled in production"
-- means as a fact rather than a promise.
CREATE TABLE police.escalation_policy (
  policy_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version                integer NOT NULL,
  minutes                integer NOT NULL,
  legal_basis            text NOT NULL,
  approved_by_account_id uuid NOT NULL,
  effective_at           timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT escalation_policy_version_uq UNIQUE (version),
  CONSTRAINT escalation_policy_minutes_bounded CHECK (minutes BETWEEN 1 AND 1440),
  CONSTRAINT escalation_policy_basis_bounded CHECK (length(legal_basis) BETWEEN 5 AND 500),
  CONSTRAINT escalation_policy_version_positive CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TRIGGER escalation_policy_append_only
  BEFORE UPDATE OR DELETE ON police.escalation_policy
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 13 §4.1: the same shape for the historical check-in search. Without an
-- approved retention configuration the Police Admin's search over checked-out
-- stays does not run in production.
CREATE TABLE police.checkin_retention_policy (
  policy_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version                integer NOT NULL,
  retention_days         integer NOT NULL,
  legal_basis            text NOT NULL,
  approved_by_account_id uuid NOT NULL,
  effective_at           timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checkin_retention_policy_version_uq UNIQUE (version),
  CONSTRAINT checkin_retention_policy_days_bounded CHECK (retention_days BETWEEN 1 AND 3650),
  CONSTRAINT checkin_retention_policy_basis_bounded CHECK (length(legal_basis) BETWEEN 5 AND 500),
  CONSTRAINT checkin_retention_policy_version_positive CHECK (version >= 1)
);
--> statement-breakpoint
CREATE TRIGGER checkin_retention_policy_append_only
  BEFORE UPDATE OR DELETE ON police.checkin_retention_policy
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- Found, and the two-person corrections
-- =====================================================================

-- doc 13 §9.1: the quick form. Everything the system already knows is written
-- by the server; the officer chooses one location kind and, off the match's
-- own hotel, says where.
CREATE TABLE police.found_confirmation (
  found_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id           uuid NOT NULL,
  found_by_account_id uuid NOT NULL,
  found_by_unit_ref  text NOT NULL,
  confirmed_at       timestamptz NOT NULL,
  location_kind      text NOT NULL,
  location_note      text,
  task_reference     text,
  note               text,
  state              text NOT NULL DEFAULT 'ACTIVE',
  corrected_at       timestamptz,
  CONSTRAINT found_confirmation_match_fkey FOREIGN KEY (match_id)
    REFERENCES police.police_match (match_id) ON DELETE RESTRICT,
  CONSTRAINT found_confirmation_kind_known
    CHECK (location_kind = ANY (ARRAY['AT_MATCH_HOTEL'::text, 'OTHER_LOCATION'::text])),
  CONSTRAINT found_confirmation_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'CORRECTED'::text])),
  -- Another location has to say which; the match's own hotel is already known,
  -- so restating it would be a second place for it to be wrong.
  CONSTRAINT found_confirmation_location_shape
    CHECK ((location_kind = 'OTHER_LOCATION'::text)
           = (location_note IS NOT NULL AND length(location_note) BETWEEN 3 AND 300)),
  CONSTRAINT found_confirmation_note_bounded
    CHECK (note IS NULL OR length(note) BETWEEN 1 AND 500),
  CONSTRAINT found_confirmation_task_bounded
    CHECK (task_reference IS NULL OR length(task_reference) BETWEEN 1 AND 100),
  CONSTRAINT found_confirmation_corrected_shape
    CHECK ((state = 'CORRECTED'::text) = (corrected_at IS NOT NULL))
);
--> statement-breakpoint
-- One live confirmation per match. A corrected one stays as history.
CREATE UNIQUE INDEX found_confirmation_active_uq
  ON police.found_confirmation (match_id) WHERE state = 'ACTIVE'::text;
--> statement-breakpoint
CREATE TRIGGER found_confirmation_no_delete
  BEFORE DELETE ON police.found_confirmation
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 13 §9.2 / `POL-DEC-015`: the officer who confirmed asks, and somebody
-- else decides. The two-person rule is the CHECK below.
CREATE TABLE police.found_correction_request (
  request_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id               uuid NOT NULL,
  found_id               uuid NOT NULL,
  requested_by_account_id uuid NOT NULL,
  reason                 text NOT NULL,
  state                  text NOT NULL DEFAULT 'PENDING',
  decided_by_account_id  uuid,
  decided_at             timestamptz,
  decision_note          text,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT found_correction_match_fkey FOREIGN KEY (match_id)
    REFERENCES police.police_match (match_id) ON DELETE RESTRICT,
  CONSTRAINT found_correction_found_fkey FOREIGN KEY (found_id)
    REFERENCES police.found_confirmation (found_id) ON DELETE RESTRICT,
  CONSTRAINT found_correction_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])),
  CONSTRAINT found_correction_reason_bounded CHECK (length(reason) BETWEEN 10 AND 500),
  CONSTRAINT found_correction_note_bounded
    CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 5 AND 500),
  CONSTRAINT found_correction_decision_shape
    CHECK ((state = 'PENDING'::text)
           = (decided_by_account_id IS NULL AND decided_at IS NULL)),
  CONSTRAINT found_correction_two_person
    CHECK (decided_by_account_id IS NULL
           OR decided_by_account_id <> requested_by_account_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX found_correction_pending_uq
  ON police.found_correction_request (match_id) WHERE state = 'PENDING'::text;
--> statement-breakpoint

-- doc 13 §9.3 / `POL-DEC-019`: the same two-person shape, one pending request
-- per match, and a reason code that is one of the approved four.
CREATE TABLE police.false_match_request (
  request_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id               uuid NOT NULL,
  requested_by_account_id uuid NOT NULL,
  reason_code            text NOT NULL,
  reason_note            text NOT NULL,
  state                  text NOT NULL DEFAULT 'PENDING',
  decided_by_account_id  uuid,
  decided_at             timestamptz,
  decision_note          text,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT false_match_match_fkey FOREIGN KEY (match_id)
    REFERENCES police.police_match (match_id) ON DELETE RESTRICT,
  CONSTRAINT false_match_reason_known
    CHECK (reason_code = ANY (ARRAY['WRONG_NUMBER_ENTERED'::text,
                                    'IDENTIFIER_USED_BY_ANOTHER'::text,
                                    'IDENTITY_DISPROVED'::text,
                                    'OTHER_VERIFIED_REASON'::text])),
  CONSTRAINT false_match_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REJECTED'::text])),
  CONSTRAINT false_match_note_bounded CHECK (length(reason_note) BETWEEN 10 AND 500),
  CONSTRAINT false_match_decision_note_bounded
    CHECK (decision_note IS NULL OR length(decision_note) BETWEEN 5 AND 500),
  CONSTRAINT false_match_decision_shape
    CHECK ((state = 'PENDING'::text)
           = (decided_by_account_id IS NULL AND decided_at IS NULL)),
  CONSTRAINT false_match_two_person
    CHECK (decided_by_account_id IS NULL
           OR decided_by_account_id <> requested_by_account_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX false_match_pending_uq
  ON police.false_match_request (match_id) WHERE state = 'PENDING'::text;
--> statement-breakpoint

-- =====================================================================
-- The four-digit bootstrap, and the Wanted Case export
-- =====================================================================

-- doc 13 §5.3 / `POL-DEC-022`: a four-digit code is ten thousand guesses, so
-- the protections are not optional decoration — they are the reason the code is
-- allowed to be four digits at all. Every one of them is here: a five-minute
-- life derived by CHECK, three attempts, one use, a keyed digest instead of the
-- code, and a lock the third failure sets.
CREATE TABLE police.bootstrap_code (
  code_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL,
  purpose        text NOT NULL,
  -- The keyed HMAC of the code, never the code (CLAUDE.md §8).
  code_hash      bytea NOT NULL,
  hash_key_version text NOT NULL,
  -- The code is bound to the phone version it was sent to: a number changed
  -- afterwards invalidates what was sent to the old one.
  phone_version  integer NOT NULL,
  issued_at      timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  attempts       integer NOT NULL DEFAULT 0,
  consumed_at    timestamptz,
  invalidated_at timestamptz,
  locked_until   timestamptz,
  CONSTRAINT bootstrap_code_purpose_known
    CHECK (purpose = ANY (ARRAY['ACCOUNT_ACTIVATION'::text, 'PASSWORD_RESET'::text])),
  CONSTRAINT bootstrap_code_ttl_derived
    CHECK (expires_at = issued_at + interval '5 minutes'),
  CONSTRAINT bootstrap_code_attempts_bounded CHECK (attempts BETWEEN 0 AND 3),
  CONSTRAINT bootstrap_code_phone_version_positive CHECK (phone_version >= 1),
  -- A code that was used is not also a code that was invalidated.
  CONSTRAINT bootstrap_code_terminal_shape
    CHECK (consumed_at IS NULL OR invalidated_at IS NULL)
);
--> statement-breakpoint
-- One live code per account and purpose: issuing a new one invalidates what
-- came before, so two cannot be guessed in parallel.
CREATE UNIQUE INDEX bootstrap_code_live_uq
  ON police.bootstrap_code (account_id, purpose)
  WHERE consumed_at IS NULL AND invalidated_at IS NULL;
--> statement-breakpoint
CREATE INDEX bootstrap_code_account_idx
  ON police.bootstrap_code (account_id, issued_at DESC);
--> statement-breakpoint

-- doc 13 §12.2: one row per Wanted Case, the registration number masked unless
-- two permissions and a recent step-up say otherwise, and a purpose and task
-- reference on every single export.
CREATE TABLE police.wanted_export_job (
  job_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by_account_id uuid NOT NULL,
  requested_at          timestamptz NOT NULL,
  purpose               text NOT NULL,
  task_reference        text NOT NULL,
  filters               jsonb NOT NULL DEFAULT '{}'::jsonb,
  full_identifier       boolean NOT NULL DEFAULT false,
  state                 text NOT NULL DEFAULT 'QUEUED',
  row_count             integer,
  storage_key           text,
  content_hash          text,
  ready_at              timestamptz,
  expires_at            timestamptz,
  failure_reason        text,
  revision              integer NOT NULL DEFAULT 0,
  CONSTRAINT wanted_export_state_known
    CHECK (state = ANY (ARRAY['QUEUED'::text, 'RUNNING'::text, 'COMPLETED'::text,
                              'FAILED'::text, 'EXPIRED'::text])),
  CONSTRAINT wanted_export_purpose_bounded CHECK (length(purpose) BETWEEN 10 AND 500),
  CONSTRAINT wanted_export_task_bounded CHECK (length(task_reference) BETWEEN 1 AND 100),
  -- The row cap is protected configuration rather than a constant, and this is
  -- the ceiling no configuration may exceed (doc 13 §12.3).
  CONSTRAINT wanted_export_row_cap CHECK (row_count IS NULL OR row_count <= 10000),
  CONSTRAINT wanted_export_ttl_derived
    CHECK ((ready_at IS NULL AND expires_at IS NULL)
           OR expires_at = ready_at + interval '1 hour'),
  CONSTRAINT wanted_export_storage_key_shape
    CHECK (storage_key IS NULL
           OR storage_key ~ '^police-exports/[0-9a-f-]{36}/[0-9a-f]{32}\.xlsx$'::text),
  CONSTRAINT wanted_export_ready_shape
    CHECK ((state = 'COMPLETED'::text)
           = (ready_at IS NOT NULL AND storage_key IS NOT NULL AND row_count IS NOT NULL)),
  CONSTRAINT wanted_export_filters_sanitised
    CHECK (NOT platform.contains_denied_key(filters)),
  CONSTRAINT wanted_export_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
CREATE INDEX wanted_export_requester_idx
  ON police.wanted_export_job (requested_by_account_id, requested_at DESC);
--> statement-breakpoint

-- doc 13 §12.3: a one-time, short-lived link. Issuing one is append-only, so
-- re-issuing cannot extend the file's own hour.
CREATE TABLE police.wanted_export_grant (
  grant_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               uuid NOT NULL,
  issued_by_account_id uuid NOT NULL,
  issued_at            timestamptz NOT NULL,
  expires_at           timestamptz NOT NULL,
  CONSTRAINT wanted_export_grant_job_fkey FOREIGN KEY (job_id)
    REFERENCES police.wanted_export_job (job_id) ON DELETE RESTRICT,
  CONSTRAINT wanted_export_grant_ttl_derived
    CHECK (expires_at = issued_at + interval '5 minutes')
);
--> statement-breakpoint
CREATE INDEX wanted_export_grant_job_idx ON police.wanted_export_grant (job_id, issued_at DESC);
--> statement-breakpoint
CREATE TRIGGER wanted_export_grant_append_only
  BEFORE UPDATE OR DELETE ON police.wanted_export_grant
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 13 §5.1 and §10.2: the official phone a Police account is reachable on.
--
-- It is a Police-schema row rather than a column on the account, for the same
-- reason everything else here is: the number is Police data, it is approved and
-- re-verified by a Police Admin, and an SMS may only ever go to one that is.
-- The number is envelope-encrypted like every other identifier, and the version
-- is what a bootstrap code binds to — so a number changed after a code was sent
-- invalidates that code by construction.
CREATE TABLE police.police_contact (
  contact_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL,
  phone_version          integer NOT NULL,
  is_current             boolean NOT NULL DEFAULT true,
  phone_ciphertext       bytea NOT NULL,
  phone_wrapped_dek      bytea NOT NULL,
  phone_key_version      text NOT NULL,
  -- The last four digits, for an operator to recognise a number by. Never more.
  phone_masked           text NOT NULL,
  verified_at            timestamptz,
  approved_by_account_id uuid NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT police_contact_version_uq UNIQUE (account_id, phone_version),
  CONSTRAINT police_contact_version_positive CHECK (phone_version >= 1),
  CONSTRAINT police_contact_mask_shape CHECK (phone_masked ~ '^\*{4,}[0-9]{4}$'::text)
);
--> statement-breakpoint
CREATE UNIQUE INDEX police_contact_current_uq
  ON police.police_contact (account_id) WHERE (is_current IS TRUE);
--> statement-breakpoint
CREATE TRIGGER police_contact_no_delete
  BEFORE DELETE ON police.police_contact
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 13 §9: every exact search is recorded — who, when, what kind, and
-- whether it found anything — and the same rows are what the rate limit counts.
-- It lives here rather than only on the Police audit stream because a limiter
-- has to read its own history, and no runtime role reads that stream.
CREATE TABLE police.exact_search_attempt (
  attempt_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  search_kind text NOT NULL,
  -- The device or address the search came from, opaque and never a person.
  device_ref  text,
  found       boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT exact_search_kind_known
    CHECK (search_kind = ANY (ARRAY['REGISTRATION_NUMBER'::text, 'MATCH_ID'::text])),
  CONSTRAINT exact_search_device_bounded
    CHECK (device_ref IS NULL OR length(device_ref) BETWEEN 1 AND 128)
);
--> statement-breakpoint
CREATE INDEX exact_search_account_idx
  ON police.exact_search_attempt (account_id, attempted_at DESC);
--> statement-breakpoint
CREATE TRIGGER exact_search_append_only
  BEFORE UPDATE OR DELETE ON police.exact_search_attempt
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 13 §12.2: the one grantable Police permission that is not a doc 18 §6
-- row. It unmasks a registration number in a Wanted Case export and grants no
-- action of its own, so the kernel's grantable list has to admit it while the
-- matrix keeps having no cell for it.
ALTER TABLE platform.account_permission_grant
  DROP CONSTRAINT account_permission_grant_grantable;
--> statement-breakpoint
-- Re-stated exactly as it stands, with one value added: every other branch is
-- reproduced from the live definition rather than from the migration that first
-- wrote it, so a permission a later phase added is not silently dropped here.
ALTER TABLE platform.account_permission_grant
  ADD CONSTRAINT account_permission_grant_grantable CHECK (
CASE realm_role
    WHEN 'OPERATION_ADMIN'::text THEN (permission = ANY (ARRAY['DEPOSIT_REFUND_RECONCILE'::text, 'ONBOARDING_PROVISION_RETRY'::text, 'OPERATION_READ'::text, 'REVIEW_MODERATE'::text, 'SUBSCRIPTION_EBARIMT_RETRY'::text, 'SUBSCRIPTION_PASSWORD_RESET_INITIATE'::text, 'SUBSCRIPTION_PAYMENT_RECONCILE'::text, 'SUBSCRIPTION_REMINDER_SEND'::text]))
    WHEN 'PLATFORM_SUPER_ADMIN'::text THEN (permission = ANY (ARRAY['ACCOUNT_OWNERSHIP_RECOVERY_APPROVE'::text, 'DEPOSIT_REFUND_RECONCILE'::text, 'ONBOARDING_PROVISION_RETRY'::text, 'OPERATION_READ'::text, 'PLATFORM_OPERATION_ACCESS_MANAGE'::text, 'REVIEW_MODERATE'::text, 'SUBSCRIPTION_CONTACT_CHANGE_APPROVE'::text, 'SUBSCRIPTION_EBARIMT_RETRY'::text, 'SUBSCRIPTION_PASSWORD_RESET_INITIATE'::text, 'SUBSCRIPTION_PAYMENT_RECONCILE'::text, 'SUBSCRIPTION_REMINDER_SEND'::text, 'SUBSCRIPTION_SUSPEND'::text]))
    WHEN 'POLICE_OFFICER'::text THEN (permission = ANY (ARRAY['FALSE_MATCH_APPROVE'::text, 'FOUND_CORRECTION_APPROVE'::text, 'WANTED_CASE_STATE_MANAGE'::text, 'WANTED_IDENTITY_APPROVE'::text]))
    WHEN 'POLICE_ADMIN'::text THEN (permission = ANY (ARRAY['FALSE_MATCH_APPROVE'::text, 'FOUND_CORRECTION_APPROVE'::text, 'WANTED_CASE_CREATE'::text, 'WANTED_CASE_EXPORT'::text, 'WANTED_CASE_STATE_MANAGE'::text, 'WANTED_EXPORT_FULL_IDENTIFIER'::text, 'WANTED_IDENTITY_APPROVE'::text]))
    ELSE false
END);
--> statement-breakpoint

-- =====================================================================
-- Row-level security: the Police realm, and nobody else
-- =====================================================================

-- The police schema has no tenant axis. A wanted person belongs to no hotel and
-- a match belongs to two worlds at once, so `hotel_id = current_hotel_id()` —
-- the isolation every platform table uses — would be the wrong question here.
--
-- What is asked instead is the realm. `prsystem_police` is the only runtime
-- role with any grant in this schema, and every policy below additionally
-- requires the transaction to have declared itself Police: a connection that
-- somehow held the role but ran as another realm reads nothing. Unit,
-- territory and case scope are doc 18 §6 rules the pipeline applies above this
-- line; RLS is the floor, not the whole of it.
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'wanted_person', 'wanted_identity_revision', 'wanted_case', 'wanted_case_event',
    'police_match', 'match_case_link', 'match_event', 'district_alert_group',
    'match_alert', 'alert_delivery', 'escalation_policy', 'checkin_retention_policy',
    'found_confirmation', 'found_correction_request', 'false_match_request',
    'bootstrap_code', 'wanted_export_job', 'wanted_export_grant', 'exact_search_attempt',
    'police_contact'
  ] LOOP
    EXECUTE format('ALTER TABLE police.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE police.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY police_realm_only ON police.%I TO prsystem_police '
      || 'USING (platform.current_realm() = ''police''::text) '
      || 'WITH CHECK (platform.current_realm() = ''police''::text)', t);
  END LOOP;
END;
$rls$;
--> statement-breakpoint

-- =====================================================================
-- Grants: the Police runtime role, and it alone
-- =====================================================================

GRANT SELECT, INSERT, UPDATE ON police.wanted_person             TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON police.wanted_identity_revision  TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON police.wanted_case               TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT         ON police.wanted_case_event         TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON police.police_match              TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT         ON police.match_case_link           TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT         ON police.match_event               TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON police.district_alert_group      TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, UPDATE         ON police.match_alert               TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON police.alert_delivery            TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT         ON police.escalation_policy         TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT         ON police.checkin_retention_policy  TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON police.found_confirmation        TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON police.found_correction_request  TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON police.false_match_request       TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON police.bootstrap_code            TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON police.wanted_export_job         TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT         ON police.wanted_export_grant       TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT         ON police.exact_search_attempt      TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON police.police_contact             TO prsystem_police;
--> statement-breakpoint

-- The Police realm signs in and runs commands, so it needs to reach the schema
-- those live in — the kernel granted `USAGE` to the API and the worker only,
-- because until now the Police role had nothing to do there.
GRANT USAGE ON SCHEMA platform TO prsystem_police;
--> statement-breakpoint

-- The Police realm signs in, so it reads the account tables the pipeline reads
-- — and nothing else of the platform schema. It holds no grant on a stay, a
-- folio, a booking or a hotel: what it may see of the hotel world it sees
-- through the three functions below, or not at all.
-- doc 13 §5.1: a Police Admin creates Police accounts, so the realm's own role
-- inserts them. The `user_account` constraint refuses a Police account with a
-- role from another realm, and no other realm's account is reachable from here.
GRANT SELECT, INSERT, UPDATE ON platform.user_account TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.account_credential TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.server_session TO prsystem_police;
--> statement-breakpoint
GRANT SELECT ON platform.account_permission_grant TO prsystem_police;
--> statement-breakpoint
-- The pipeline resolves a principal the same way in every realm, and that read
-- includes the account's memberships. A Police account has none — and the two
-- grants below are `SELECT` only, under the ordinary tenant policy, so a Police
-- transaction at the platform scope reads exactly zero rows from either.
GRANT SELECT ON platform.staff_membership, platform.membership_role_grant TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.idempotency_key TO prsystem_police;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.outbox_event TO prsystem_police;
--> statement-breakpoint

-- =====================================================================
-- The three functions that cross the boundary, and nothing else does
-- =====================================================================

-- Police data and hotel data have separate roles, separate schemas and separate
-- grants, and doc 13 §3 means that to stay true. But three readings genuinely
-- cross: a check-in has to be compared against wanted people, a case that has
-- just been activated has to be swept against the guests who are in hotels
-- right now, and doc 13 §4.1 approves one all-hotel check-in list for the
-- Police Admin.
--
-- Each is a `SECURITY DEFINER` function owned by the login-less function owner,
-- granted to exactly one runtime role, and narrow enough that it cannot be used
-- for anything else: the first answers nothing to its caller about who was
-- wanted, the second answers only for a token the caller already holds, and the
-- third is the approved column list and no more.
-- The function owner needs to be able to own a function in this schema for the
-- length of this migration, and needs to read it afterwards. `CREATE` is
-- withdrawn at the end; `USAGE` stays, because a `SECURITY DEFINER` function
-- executes as its owner and its owner must be able to reach the schema.
GRANT USAGE, CREATE ON SCHEMA police TO prsystem_maintenance_fn;
--> statement-breakpoint
-- The worker calls two functions in this schema and holds no privilege on any
-- table in it. `USAGE` is what lets it name them; the functions themselves are
-- what decide anything.
GRANT USAGE ON SCHEMA police TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON police.wanted_person, police.wanted_case, police.wanted_identity_revision
  TO prsystem_maintenance_fn;
--> statement-breakpoint
-- `RETURNING` is a read: the matcher inserts a match and an alert and needs
-- both ids back, so it holds `SELECT` on exactly those two and on nothing else
-- it writes.
GRANT SELECT ON police.police_match, police.match_alert TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT INSERT ON police.police_match, police.match_case_link, police.match_event,
                police.match_alert, police.alert_delivery
  TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT ON police.district_alert_group TO prsystem_maintenance_fn;
--> statement-breakpoint
-- RLS is FORCEd on every table above, so the owner of a definer function is
-- subject to it exactly as a runtime role is. These are the narrow policies
-- that let the three functions do their work and nothing wider: read the
-- wanted people and their active cases, and write the detection rows.
-- The matcher sees a wanted person only while somebody is actively wanted:
-- a draft, a suspended case or a closed one leaves the person unreadable
-- through this role, which is the same thing as unmatchable.
CREATE POLICY police_matcher_read ON police.wanted_person
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM police.wanted_case c
                  WHERE c.person_id = wanted_person.person_id
                    AND c.state = 'ACTIVE'::text));
--> statement-breakpoint
CREATE POLICY police_matcher_read ON police.wanted_case
  FOR SELECT TO prsystem_maintenance_fn USING (state = 'ACTIVE'::text);
--> statement-breakpoint
-- Only the approved current revision, and only to establish that the person has
-- one: no name, no birth date and no address is selected by any of the three
-- functions, and none could be.
CREATE POLICY police_matcher_read ON police.wanted_identity_revision
  FOR SELECT TO prsystem_maintenance_fn
  USING (is_current IS TRUE AND approval_state = 'APPROVED'::text);
--> statement-breakpoint
CREATE POLICY police_matcher_read ON police.district_alert_group
  FOR SELECT TO prsystem_maintenance_fn USING (state = 'ACTIVE'::text);
--> statement-breakpoint
CREATE POLICY police_matcher_write ON police.police_match
  FOR INSERT TO prsystem_maintenance_fn WITH CHECK (workflow_state = 'NEW'::text);
--> statement-breakpoint
-- And read the unresolved ones, for the stale-location sweep below. A resolved
-- match is not readable through this role at all.
CREATE POLICY police_matcher_read ON police.police_match
  FOR SELECT TO prsystem_maintenance_fn USING (workflow_state <> 'RESOLVED'::text);
--> statement-breakpoint
CREATE POLICY police_matcher_write ON police.match_case_link
  FOR INSERT TO prsystem_maintenance_fn WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY police_matcher_write ON police.match_event
  FOR INSERT TO prsystem_maintenance_fn WITH CHECK (actor_account_id IS NULL);
--> statement-breakpoint
CREATE POLICY police_matcher_write ON police.match_alert
  FOR INSERT TO prsystem_maintenance_fn WITH CHECK (escalation_stage = 0);
--> statement-breakpoint
CREATE POLICY police_matcher_read ON police.match_alert
  FOR SELECT TO prsystem_maintenance_fn USING (escalation_stage = 0);
--> statement-breakpoint
CREATE POLICY police_matcher_write ON police.alert_delivery
  FOR INSERT TO prsystem_maintenance_fn
  WITH CHECK (delivered_at IS NULL AND opened_at IS NULL AND provider_message_id IS NULL);
--> statement-breakpoint

-- The rows those functions must reach, stated as the rule rather than as
-- `true`: every provisioned hotel — a match is not confined to the hotels that
-- chose to be listed publicly — and, for the check-in list, the stay and its
-- one primary guest.
CREATE POLICY police_hotel_read ON platform.hotel
  FOR SELECT TO prsystem_maintenance_fn
  USING (true);
--> statement-breakpoint
CREATE POLICY police_hotel_read ON platform.hotel_profile
  FOR SELECT TO prsystem_maintenance_fn
  USING (true);
--> statement-breakpoint
CREATE POLICY police_stay_read ON platform.stay
  FOR SELECT TO prsystem_maintenance_fn
  USING (true);
--> statement-breakpoint
CREATE POLICY police_room_read ON platform.room
  FOR SELECT TO prsystem_maintenance_fn
  USING (true);
--> statement-breakpoint
-- Only the current revision of the guest row, which — by `RC-DEC-033`, one
-- primary guest per stay — is exactly what doc 13 §4.1's list is a list of.
-- A superseded revision is not readable through this role at all.
CREATE POLICY police_guest_read ON platform.stay_guest
  FOR SELECT TO prsystem_maintenance_fn
  USING (is_current IS TRUE);
--> statement-breakpoint
-- Alert routing has to know which Police accounts are active and where they
-- serve. It reaches no other realm's accounts.
CREATE POLICY police_account_read ON platform.user_account
  FOR SELECT TO prsystem_maintenance_fn
  USING (realm = 'police'::text);
--> statement-breakpoint
-- doc 13 §4.1: the list shows the latest approved effective actual check-in, so
-- the approved corrections of a stay are readable and nothing else of them is.
CREATE POLICY police_correction_read ON platform.stay_time_correction
  FOR SELECT TO prsystem_maintenance_fn
  USING (state = 'APPROVED'::text);
--> statement-breakpoint
GRANT SELECT ON platform.hotel, platform.hotel_profile, platform.stay,
                platform.stay_guest, platform.room, platform.stay_time_correction,
                platform.user_account
  TO prsystem_maintenance_fn;
--> statement-breakpoint

-- doc 13 §8.3, trigger 1. The worker relays `stay.checked_in` and calls this;
-- everything it needs is in that event, and what it gets back is a match id or
-- nothing. It cannot be asked "is this person wanted" in any other way, and it
-- returns no identity, no case and no reason — the worker learns only that
-- there is Police work, which the worker already had to know to call it.
CREATE FUNCTION police.record_check_in_match(
  p_stay_id              uuid,
  p_hotel_id             uuid,
  p_room_number          text,
  p_check_in_recorded_at timestamptz,
  p_actual_check_in_at   timestamptz,
  p_detected_at          timestamptz,
  p_eligibility          text,
  p_namespace            text,
  p_token                text,
  p_key_version          text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, police, platform
AS $$
DECLARE
  v_person   record;
  v_hotel    record;
  v_match_id uuid;
  v_alert_id uuid;
  v_case     record;
  v_district text;
  v_group    record;
  v_officer  record;
  v_routing_error boolean := false;
BEGIN
  -- doc 13 §8.2: only a structurally valid normalized `MN_REG_NO` is eligible.
  -- Everything else — a passport, another government id, no document, a number
  -- that failed its own structure check — has no exact-match path at all.
  IF p_eligibility IS DISTINCT FROM 'ELIGIBLE_EXACT_RD'::text
     OR p_token IS NULL OR p_namespace IS NULL OR p_key_version IS NULL THEN
    RETURN NULL;
  END IF;

  -- The key version is part of the comparison: a token derived under a rotated
  -- key is a different value, and treating it as equal would be a false match.
  SELECT p.person_id INTO v_person
    FROM police.wanted_person p
   WHERE p.match_namespace = p_namespace
     AND p.match_token = p_token
     AND p.match_key_version = p_key_version
     AND EXISTS (SELECT 1 FROM police.wanted_identity_revision r
                  WHERE r.person_id = p.person_id AND r.is_current)
     AND EXISTS (SELECT 1 FROM police.wanted_case c
                  WHERE c.person_id = p.person_id AND c.state = 'ACTIVE'::text);
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT h.hotel_id, h.display_name,
         pr.district, pr.address_line, pr.latitude_micro, pr.longitude_micro
    INTO v_hotel
    FROM platform.hotel h
    LEFT JOIN platform.hotel_profile pr ON pr.hotel_id = h.hotel_id
   WHERE h.hotel_id = p_hotel_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_district := coalesce(v_hotel.district, 'Тодорхойгүй');

  -- `POL-DEC-017`: one match per stay and person. A replayed event, a second
  -- relay pass or a retried job finds the row already there and creates no
  -- second alert.
  INSERT INTO police.police_match
    (stay_id, wanted_person_id, hotel_id, hotel_name, hotel_district,
     hotel_address_line, latitude_micro, longitude_micro, room_number,
     detected_at, check_in_recorded_at, actual_check_in_at, originating_unit_ref)
  SELECT p_stay_id, v_person.person_id, v_hotel.hotel_id, v_hotel.display_name,
         v_district, coalesce(v_hotel.address_line, ''),
         v_hotel.latitude_micro, v_hotel.longitude_micro, p_room_number,
         p_detected_at, p_check_in_recorded_at, p_actual_check_in_at,
         coalesce((SELECT c.owning_unit_ref FROM police.wanted_case c
                    WHERE c.person_id = v_person.person_id AND c.state = 'ACTIVE'::text
                    ORDER BY c.activated_at LIMIT 1), 'UNASSIGNED')
  ON CONFLICT (stay_id, wanted_person_id) DO NOTHING
  RETURNING match_id INTO v_match_id;
  IF v_match_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO police.match_event (match_id, event_type, payload, occurred_at)
  VALUES (v_match_id, 'DETECTED',
          jsonb_build_object('method', 'EXACT_REGISTRATION_NUMBER',
                             'district', v_district),
          p_detected_at);

  -- Every case that is active at this instant is linked. One that activates
  -- later, while the stay is still open, is linked by the sweep — not here.
  FOR v_case IN
    SELECT c.case_id FROM police.wanted_case c
     WHERE c.person_id = v_person.person_id AND c.state = 'ACTIVE'::text
  LOOP
    -- No conflict clause: the loop only runs for a match this call created,
    -- so every link below is new. A repeated event returned above, at the
    -- unique pair, before reaching here.
    INSERT INTO police.match_case_link (match_id, case_id)
    VALUES (v_match_id, v_case.case_id);
    INSERT INTO police.match_event (match_id, event_type, payload, occurred_at)
    VALUES (v_match_id, 'CASE_LINKED',
            jsonb_build_object('caseId', v_case.case_id), p_detected_at);
  END LOOP;

  -- doc 13 §10.1: routing is by the district the hotel is in. A district with
  -- no approved active group still alerts the Police Admins, and records that
  -- the routing failed rather than reporting a success nobody received.
  SELECT g.district, g.unit_ref INTO v_group
    FROM police.district_alert_group g
   WHERE g.district = v_district AND g.state = 'ACTIVE'::text;
  v_routing_error := NOT FOUND;

  INSERT INTO police.match_alert (match_id, created_at, routing_error, routed_district)
  VALUES (v_match_id, p_detected_at, v_routing_error, v_district)
  RETURNING alert_id INTO v_alert_id;

  INSERT INTO police.match_event (match_id, event_type, payload, occurred_at)
  VALUES (v_match_id, 'ALERT_CREATED',
          jsonb_build_object('routingError', v_routing_error, 'district', v_district),
          p_detected_at);

  -- Both channels, for both kinds of recipient: every active Police Admin
  -- always, and the active officers of the district's approved group. The rows
  -- are created here and delivered by the Police service under its own role —
  -- the body of an SMS is not something a database function should hold.
  FOR v_officer IN
    SELECT a.account_id,
           CASE WHEN a.realm_role = 'POLICE_ADMIN'::text
                THEN 'POLICE_ADMIN'::text ELSE 'DISTRICT_OFFICER'::text END AS kind
      FROM platform.user_account a
     WHERE a.realm = 'police'::text
       AND a.state = 'ACTIVE'::text
       AND (a.realm_role = 'POLICE_ADMIN'::text
            OR (NOT v_routing_error
                AND a.realm_role = 'POLICE_OFFICER'::text
                AND a.police_scope_ref = v_group.unit_ref))
  LOOP
    INSERT INTO police.alert_delivery (alert_id, recipient_account_id, recipient_kind, channel)
    VALUES (v_alert_id, v_officer.account_id, v_officer.kind, 'IN_APP'),
           (v_alert_id, v_officer.account_id, v_officer.kind, 'SMS');
  END LOOP;

  RETURN v_match_id;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION police.record_check_in_match(uuid, uuid, text, timestamptz, timestamptz,
  timestamptz, text, text, text, text) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION police.record_check_in_match(uuid, uuid, text, timestamptz, timestamptz,
  timestamptz, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
-- The Police role calls the same function for doc 13 §8.3's second trigger: a
-- case that has just been activated is swept against the guests who are in
-- hotels right now. One implementation, so the two triggers cannot drift into
-- creating different matches — and the sweep cannot reach a stay the function
-- would not have matched anyway.
GRANT EXECUTE ON FUNCTION police.record_check_in_match(uuid, uuid, text, timestamptz, timestamptz,
  timestamptz, text, text, text, text) TO prsystem_worker, prsystem_police;
--> statement-breakpoint

-- The events the matcher has not consumed yet.
--
-- `stay.checked_in` is written in the hotel's own scope, so finding them across
-- every hotel needs a definer — and this one answers two identifiers and
-- nothing else. The worker then reads the event in that hotel's scope, under
-- its own role and the ordinary policy, and claims the consumption there.
CREATE FUNCTION police.pending_check_in_events(p_limit integer)
RETURNS TABLE (event_id bigint, hotel_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, police, platform
AS $$
  SELECT e.event_id, e.hotel_id
    FROM platform.outbox_event e
   WHERE e.event_type = 'stay.checked_in'
     AND NOT EXISTS (SELECT 1 FROM platform.inbox_consumption c
                      WHERE c.consumer = 'police.matcher'
                        AND c.dedup_key = e.event_id::text)
   ORDER BY e.event_id
   LIMIT greatest(p_limit, 0);
$$;
--> statement-breakpoint
ALTER FUNCTION police.pending_check_in_events(integer) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION police.pending_check_in_events(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION police.pending_check_in_events(integer) TO prsystem_worker;
--> statement-breakpoint
CREATE POLICY police_matcher_read ON platform.outbox_event
  FOR SELECT TO prsystem_maintenance_fn
  USING (event_type = 'stay.checked_in'::text);
--> statement-breakpoint
CREATE POLICY police_matcher_read ON platform.inbox_consumption
  FOR SELECT TO prsystem_maintenance_fn
  USING (consumer = 'police.matcher'::text);
--> statement-breakpoint
GRANT SELECT ON platform.outbox_event, platform.inbox_consumption TO prsystem_maintenance_fn;
--> statement-breakpoint

-- doc 13 §8.3, trigger 2: a case has just become active, so the guests who are
-- in hotels *right now* are swept once. It answers only for the token the
-- caller passes — which the caller holds because it is the wanted person's own
-- — so it cannot be used to enumerate anybody's guests.
--
-- MVP-д retroactive matching байхгүй: a stay that has already checked out is
-- not here, and there is no parameter that would bring it back.
CREATE FUNCTION police.active_stays_for_match(
  p_namespace   text,
  p_token       text,
  p_key_version text
)
RETURNS TABLE (
  stay_id              uuid,
  hotel_id             uuid,
  hotel_name           text,
  hotel_district       text,
  hotel_address_line   text,
  latitude_micro       integer,
  longitude_micro      integer,
  room_number          text,
  check_in_recorded_at timestamptz,
  actual_check_in_at   timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, police, platform
AS $$
  SELECT s.stay_id, h.hotel_id, h.display_name,
         coalesce(pr.district, 'Тодорхойгүй'), coalesce(pr.address_line, ''),
         pr.latitude_micro, pr.longitude_micro, r.room_number,
         s.check_in_recorded_at, s.actual_check_in_at
    FROM platform.stay_guest g
    JOIN platform.stay s ON s.stay_id = g.stay_id
    JOIN platform.hotel h ON h.hotel_id = s.hotel_id
    JOIN platform.room r ON r.room_id = s.room_id
    LEFT JOIN platform.hotel_profile pr ON pr.hotel_id = s.hotel_id
   WHERE g.is_current
     AND g.police_match_eligibility = 'ELIGIBLE_EXACT_RD'
     AND g.lookup_namespace = p_namespace
     AND g.lookup_token = p_token
     AND g.lookup_key_version = p_key_version
     AND s.state = 'ACTIVE'
     AND s.actual_checkout_at IS NULL;
$$;
--> statement-breakpoint
ALTER FUNCTION police.active_stays_for_match(text, text, text)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION police.active_stays_for_match(text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION police.active_stays_for_match(text, text, text) TO prsystem_police;
--> statement-breakpoint

-- doc 13 §9.2: a guest who checked out before anybody arrived is not a False
-- Match, and the system has to be able to tell the difference. This answers
-- which unresolved matches are about a stay that has ended — nothing else, and
-- nothing about the stay beyond that it is over.
CREATE FUNCTION police.stale_match_locations(p_limit integer)
RETURNS TABLE (match_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, police, platform
AS $$
  SELECT m.match_id
    FROM police.police_match m
    JOIN platform.stay s ON s.stay_id = m.stay_id
   WHERE m.workflow_state <> 'RESOLVED'
     AND (s.state <> 'ACTIVE' OR s.actual_checkout_at IS NOT NULL)
   ORDER BY m.detected_at
   LIMIT greatest(p_limit, 0);
$$;
--> statement-breakpoint
ALTER FUNCTION police.stale_match_locations(integer) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION police.stale_match_locations(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION police.stale_match_locations(integer) TO prsystem_police;
--> statement-breakpoint

-- doc 13 §4.1: the Police Admin's all-hotel check-in list, in exactly the
-- approved columns. Money, deposits, restaurant and minibar are not among them
-- and cannot be reached from here. The identifier travels as its ciphertext:
-- the Police Admin sees the full number, and the decryption happens in the
-- application under the Police key scope, not in a view a query could join to.
--
-- The window is the caller's, and the caller is required to have one: doc 13
-- §4.1 gives a historical search a mandatory reason and at most 31 days, and
-- both are enforced above this function, which is why it takes the window as
-- two required bounds rather than defaulting them.
CREATE FUNCTION police.check_in_list(
  p_from        timestamptz,
  p_to          timestamptz,
  p_active_only boolean,
  p_limit       integer,
  p_offset      integer
)
RETURNS TABLE (
  stay_id                uuid,
  -- The guest row's own id: the identifier was sealed against it, so it is what
  -- the application must present to open the envelope (ADR-0020 §5).
  guest_record_id        uuid,
  hotel_name             text,
  district               text,
  family_name            text,
  given_name             text,
  identifier_ciphertext  bytea,
  identifier_wrapped_dek bytea,
  identifier_key_version text,
  identity_type          text,
  room_number            text,
  check_in_at            timestamptz,
  planned_checkout_at    timestamptz,
  stay_type              text,
  source                 text,
  stay_state             text,
  total_rows             bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, police, platform
AS $$
  WITH rows AS (
    SELECT s.stay_id, g.guest_record_id, h.display_name AS hotel_name,
           coalesce(pr.district, 'Тодорхойгүй') AS district,
           g.family_name, g.given_name,
           g.identifier_ciphertext, g.identifier_wrapped_dek, g.identifier_key_version,
           g.identity_type, r.room_number,
           -- doc 13 §4.1: the latest approved effective actual check-in.
           coalesce((SELECT c.corrected_actual_check_in_at
                       FROM platform.stay_time_correction c
                      WHERE c.stay_id = s.stay_id AND c.state = 'APPROVED'
                      ORDER BY c.decided_at DESC LIMIT 1),
                    s.actual_check_in_at) AS check_in_at,
           s.planned_checkout_at, s.stay_type, s.source, s.state AS stay_state
      FROM platform.stay s
      JOIN platform.stay_guest g ON g.stay_id = s.stay_id AND g.is_current
      JOIN platform.hotel h ON h.hotel_id = s.hotel_id
      JOIN platform.room r ON r.room_id = s.room_id
      LEFT JOIN platform.hotel_profile pr ON pr.hotel_id = s.hotel_id
     WHERE (p_active_only AND s.state = 'ACTIVE' AND s.actual_checkout_at IS NULL)
        OR (NOT p_active_only
            AND s.check_in_recorded_at >= p_from
            AND s.check_in_recorded_at < p_to)
  )
  SELECT stay_id, guest_record_id, hotel_name, district, family_name, given_name,
         identifier_ciphertext, identifier_wrapped_dek, identifier_key_version,
         identity_type, room_number, check_in_at, planned_checkout_at,
         stay_type, source, stay_state,
         count(*) OVER () AS total_rows
    FROM rows
   ORDER BY check_in_at DESC, stay_id
   LIMIT greatest(p_limit, 0) OFFSET greatest(p_offset, 0);
$$;
--> statement-breakpoint
ALTER FUNCTION police.check_in_list(timestamptz, timestamptz, boolean, integer, integer)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION police.check_in_list(timestamptz, timestamptz, boolean, integer, integer)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION police.check_in_list(timestamptz, timestamptz, boolean, integer, integer)
  TO prsystem_police;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA police FROM prsystem_maintenance_fn;
--> statement-breakpoint
