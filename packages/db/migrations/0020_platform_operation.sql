-- =====================================================================
-- 0020 — Platform Operation: named accounts, the dashboard, contact,
--        suspension, reconciliation evidence and manual-only SMS
--
-- Phase 05 already built the two Operation actions that touch a hotel's rows —
-- a provisioning retry and a receipt reopening — and left the realm without a
-- way to sign in, without a dashboard and without a second factor. This
-- migration is the rest of doc 14, and five rules shape it.
--
-- **A role name grants nothing, and a name is not an account** (`OPS-DEC-015`,
-- doc 18 §5). Every Operation action names an explicitly granted permission,
-- every Operation account is one named person, and shared accounts are refused
-- structurally: an account carries exactly one credential and exactly one TOTP
-- factor, and the factor is what a step-up re-proves.
--
-- **`Идэвхжээгүй` is not a subscription state** (`OPS-DEC-013`,
-- `OPS-DEC-016`). It is a grouping of paid applications that have not finished
-- provisioning, and it lives in the application queue. Nothing in this
-- migration stores a subscription status, because doc 14 §4 derives all five
-- from `expires_at`, the server's clock and `suspended_at` — a stored copy
-- would be a second place the boundary lives.
--
-- **Suspension is an access override, never a pause** (`OPS-DEC-016`). It
-- writes `suspended_at` and an append-only event, and it touches neither
-- `starts_at` nor `expires_at` nor a renewal base. The event snapshots the
-- expiry precisely so a test can assert that calendar time carried on.
--
-- **The operator never holds the secret.** A password reset is queued by a
-- `SECURITY DEFINER` function that reads the registered address and returns it
-- masked, so the address does not cross into the application at all; a contact
-- change is two six-digit codes stored as keyed digests; the Super Admin's
-- offline exception waives the old number's challenge and nothing else. There
-- is no column anywhere below for an email an operator chose.
--
-- **No scheduler may send an SMS** (`OPS-DEC-010`). A send job exists only with
-- a `confirmed_by_account_id` and the preview it was confirmed from, and the
-- preview carries the hash of the body and of the recipient set it was computed
-- over — so a changed body or a changed filter cannot be confirmed against an
-- old preview. One recipient message per phone per job is a unique index, not a
-- convention.
-- =====================================================================

-- =====================================================================
-- The Operation account's second factor
-- =====================================================================

-- doc 14 §2 / architecture 05 §2: password + TOTP, a 30-minute idle session, an
-- 8-hour absolute one, and a step-up no older than ten minutes on every action
-- in doc 18 §5.
--
-- `A-P19-1`: TOTP is RFC 6238 and needs no provider, so it is implemented
-- rather than gated. The secret is held under envelope encryption with its key
-- version, exactly like every other secret the platform stores, and
-- `last_accepted_step` is what makes a code single-use: a replay inside the
-- same thirty seconds is refused by the row rather than by the service.
CREATE TABLE platform.operation_totp_factor (
  account_id          uuid PRIMARY KEY,
  secret_ciphertext   bytea NOT NULL,
  secret_wrapped_dek  bytea NOT NULL,
  secret_key_version  text NOT NULL,
  digits              integer NOT NULL DEFAULT 6,
  period_seconds      integer NOT NULL DEFAULT 30,
  last_accepted_step  bigint,
  enrolled_at         timestamptz NOT NULL DEFAULT now(),
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT operation_totp_factor_account_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT operation_totp_factor_digits_known CHECK (digits = 6),
  CONSTRAINT operation_totp_factor_period_known CHECK (period_seconds = 30),
  CONSTRAINT operation_totp_factor_step_non_negative
    CHECK ((last_accepted_step IS NULL) OR (last_accepted_step >= 0)),
  CONSTRAINT operation_totp_factor_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- doc 14 §2: only a Platform Super Admin holding `PLATFORM_OPERATION_ACCESS_MANAGE`
-- creates an Operation account, and the person who will use it sets their own
-- password and enrols their own factor from a one-time link sent to their
-- registered address. `A-P19-2`: doc 14 does not describe the ceremony, so this
-- is the shape Phase 05 already uses for a Hotel Admin's first sign-in — a
-- short-lived, hashed, single-use token — rather than a new one.
CREATE TABLE platform.operation_account_enrolment (
  enrolment_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL,
  state                   text NOT NULL DEFAULT 'PENDING',
  token_hash              text,
  token_key_version       text,
  expires_at              timestamptz,
  created_by_account_id   uuid NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  completed_at            timestamptz,
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT operation_account_enrolment_account_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT operation_account_enrolment_creator_fkey FOREIGN KEY (created_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT operation_account_enrolment_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'COMPLETED'::text, 'CANCELLED'::text])),
  CONSTRAINT operation_account_enrolment_completed_has_time
    CHECK ((state = 'COMPLETED'::text) = (completed_at IS NOT NULL)),
  -- A live token exists only while the enrolment is pending, and always with
  -- its key version and its expiry beside it.
  CONSTRAINT operation_account_enrolment_token_complete
    CHECK (num_nonnulls(token_hash, token_key_version, expires_at) = ANY (ARRAY[0, 3])),
  CONSTRAINT operation_account_enrolment_token_only_while_pending
    CHECK ((token_hash IS NULL) OR (state = 'PENDING'::text)),
  CONSTRAINT operation_account_enrolment_token_shape
    CHECK ((token_hash IS NULL) OR (token_hash ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT operation_account_enrolment_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT operation_account_enrolment_token_uq UNIQUE (token_hash)
);
--> statement-breakpoint
CREATE UNIQUE INDEX operation_account_enrolment_pending_uq
  ON platform.operation_account_enrolment (account_id)
  WHERE state = 'PENDING'::text;
--> statement-breakpoint

-- The realm guard. An Operation factor or enrolment on a Hotel, Guest or Police
-- account would be a second authentication path into a realm that has its own,
-- so it is refused by the database rather than by whichever service happened to
-- write the row.
CREATE OR REPLACE FUNCTION platform.operation_account_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_realm text;
BEGIN
  SELECT realm INTO v_realm FROM platform.user_account WHERE account_id = NEW.account_id;
  IF v_realm IS DISTINCT FROM 'operation' THEN
    RAISE EXCEPTION 'account % is not an Operation account', NEW.account_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operation_totp_factor_realm_guard
  BEFORE INSERT OR UPDATE ON platform.operation_totp_factor
  FOR EACH ROW EXECUTE FUNCTION platform.operation_account_guard();
--> statement-breakpoint
CREATE TRIGGER operation_account_enrolment_realm_guard
  BEFORE INSERT OR UPDATE ON platform.operation_account_enrolment
  FOR EACH ROW EXECUTE FUNCTION platform.operation_account_guard();
--> statement-breakpoint

-- =====================================================================
-- The offline ownership-recovery handoff
-- =====================================================================

-- doc 14 §2.2 / `OPS-DEC-009`. What matters here is what the table does *not*
-- have: no new email, no destination, no verification token. An Operation user
-- may record that somebody has lost access to their registered address and hand
-- it to a Platform Super Admin holding `ACCOUNT_OWNERSHIP_RECOVERY_APPROVE`;
-- the identity check itself is an approved offline procedure that this MVP does
-- not perform, so there is nothing here for it to write into.
--
-- Two people, compared on account ids, as everywhere else a decision matters.
CREATE TABLE platform.account_recovery_request (
  request_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid NOT NULL,
  state                   text NOT NULL DEFAULT 'PENDING',
  case_reference          text NOT NULL,
  request_note            text NOT NULL,
  requested_by_account_id uuid NOT NULL,
  requested_at            timestamptz NOT NULL DEFAULT now(),
  decided_by_account_id   uuid,
  decision_reason         text,
  decided_at              timestamptz,
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT account_recovery_request_account_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT account_recovery_request_requester_fkey FOREIGN KEY (requested_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT account_recovery_request_decider_fkey FOREIGN KEY (decided_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT account_recovery_request_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'APPROVED'::text, 'REFUSED'::text])),
  CONSTRAINT account_recovery_request_decision_complete
    CHECK (num_nonnulls(decided_by_account_id, decision_reason, decided_at)
           = CASE WHEN state = 'PENDING'::text THEN 0 ELSE 3 END),
  -- `OPS-DEC-015`: the operator who escalated is not the Super Admin who decides.
  CONSTRAINT account_recovery_request_two_people
    CHECK ((decided_by_account_id IS NULL)
           OR (decided_by_account_id <> requested_by_account_id)),
  CONSTRAINT account_recovery_request_reference_bounded
    CHECK (length(case_reference) BETWEEN 3 AND 120),
  CONSTRAINT account_recovery_request_note_bounded
    CHECK (length(request_note) BETWEEN 10 AND 1000),
  CONSTRAINT account_recovery_request_reason_bounded
    CHECK ((decision_reason IS NULL) OR (length(decision_reason) BETWEEN 10 AND 1000)),
  CONSTRAINT account_recovery_request_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint
-- One open escalation per account: a second one would be two Super Admins
-- deciding the same loss of access from two different case files.
CREATE UNIQUE INDEX account_recovery_request_open_uq
  ON platform.account_recovery_request (account_id)
  WHERE state = 'PENDING'::text;
--> statement-breakpoint

-- =====================================================================
-- The subscription contact, and the two challenges that change it
-- =====================================================================

-- doc 14 §5.1: one hotel may have several numbers; exactly one of them receives
-- subscription SMS, and it is confirmed and stored as its own thing. The
-- revisions are append-only — a superseded row keeps its phone, so the audit of
-- §2.3 is the table itself rather than a payload beside it.
CREATE TABLE platform.subscription_contact (
  contact_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id               uuid NOT NULL,
  subscription_id        uuid NOT NULL,
  phone                  text NOT NULL,
  is_current             boolean NOT NULL DEFAULT true,
  source                 text NOT NULL,
  change_request_id      uuid,
  changed_by_account_id  uuid,
  effective_from         timestamptz NOT NULL DEFAULT now(),
  superseded_at          timestamptz,
  CONSTRAINT subscription_contact_subscription_fkey FOREIGN KEY (hotel_id, subscription_id)
    REFERENCES platform.hotel_subscription (hotel_id, subscription_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_contact_actor_fkey FOREIGN KEY (changed_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_contact_phone_shape CHECK (phone ~ '^\+976[0-9]{8}$'::text),
  -- The seed a provisioning writes has no requester and no change request; a
  -- revision a contact change writes has both. Neither shape can be the other.
  CONSTRAINT subscription_contact_source_known
    CHECK (source = ANY (ARRAY['PROVISIONING'::text, 'CONTACT_CHANGE'::text])),
  CONSTRAINT subscription_contact_change_shape
    CHECK (CASE source
             WHEN 'CONTACT_CHANGE'::text THEN
               change_request_id IS NOT NULL AND changed_by_account_id IS NOT NULL
             ELSE change_request_id IS NULL AND changed_by_account_id IS NULL
           END),
  CONSTRAINT subscription_contact_current_has_no_end
    CHECK (is_current = (superseded_at IS NULL)),
  CONSTRAINT subscription_contact_scope_uq UNIQUE (hotel_id, contact_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX subscription_contact_current_uq
  ON platform.subscription_contact (subscription_id)
  WHERE is_current IS TRUE;
--> statement-breakpoint

-- doc 14 §2.3: one non-terminal change request per subscription, and both
-- numbers challenged before the swap.
--
-- `exception_*` is the Platform Super Admin's waiver of the *old* number's
-- challenge and of nothing else — the CHECK below makes an approved exception
-- and a verified old number mutually exclusive, so a waiver can never be
-- mistaken for a passed challenge, and the new number is still outstanding
-- either way.
CREATE TABLE platform.subscription_contact_change_request (
  request_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                      uuid NOT NULL,
  subscription_id               uuid NOT NULL,
  state                         text NOT NULL DEFAULT 'AWAITING_OLD_PHONE',
  old_phone                     text NOT NULL,
  new_phone                     text NOT NULL,
  requested_by_account_id       uuid NOT NULL,
  old_phone_verified_at         timestamptz,
  new_phone_verified_at         timestamptz,
  exception_approved_by_account_id uuid,
  exception_reference           text,
  exception_reason              text,
  exception_approved_at         timestamptz,
  applied_contact_id            uuid,
  created_at                    timestamptz NOT NULL DEFAULT now(),
  terminal_at                   timestamptz,
  terminal_reason               text,
  revision                      integer NOT NULL DEFAULT 0,
  CONSTRAINT subscription_contact_change_subscription_fkey FOREIGN KEY (hotel_id, subscription_id)
    REFERENCES platform.hotel_subscription (hotel_id, subscription_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_contact_change_requester_fkey FOREIGN KEY (requested_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_contact_change_approver_fkey
    FOREIGN KEY (exception_approved_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_contact_change_applied_fkey FOREIGN KEY (hotel_id, applied_contact_id)
    REFERENCES platform.subscription_contact (hotel_id, contact_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_contact_change_state_known
    CHECK (state = ANY (ARRAY['AWAITING_OLD_PHONE'::text, 'AWAITING_NEW_PHONE'::text,
                              'APPLIED'::text, 'CANCELLED'::text, 'EXPIRED'::text])),
  CONSTRAINT subscription_contact_change_phone_shape
    CHECK (old_phone ~ '^\+976[0-9]{8}$'::text AND new_phone ~ '^\+976[0-9]{8}$'::text),
  CONSTRAINT subscription_contact_change_is_a_change CHECK (old_phone <> new_phone),
  CONSTRAINT subscription_contact_change_terminal_has_time
    CHECK ((state = ANY (ARRAY['AWAITING_OLD_PHONE'::text, 'AWAITING_NEW_PHONE'::text]))
           = (terminal_at IS NULL)),
  CONSTRAINT subscription_contact_change_applied_shape
    CHECK ((state = 'APPLIED'::text) = (applied_contact_id IS NOT NULL)),
  -- An applied request passed the new number's challenge, and cleared the old
  -- one either by passing it or by an approved exception.
  CONSTRAINT subscription_contact_change_applied_is_verified
    CHECK ((state <> 'APPLIED'::text)
           OR (new_phone_verified_at IS NOT NULL
               AND (old_phone_verified_at IS NOT NULL OR exception_approved_at IS NOT NULL))),
  CONSTRAINT subscription_contact_change_exception_complete
    CHECK (num_nonnulls(exception_approved_by_account_id, exception_reference,
                        exception_reason, exception_approved_at) = ANY (ARRAY[0, 4])),
  -- A waiver is not a challenge. Exactly one of the two may clear the old number.
  CONSTRAINT subscription_contact_change_waiver_is_not_a_pass
    CHECK ((exception_approved_at IS NULL) OR (old_phone_verified_at IS NULL)),
  CONSTRAINT subscription_contact_change_exception_reference_bounded
    CHECK ((exception_reference IS NULL) OR (length(exception_reference) BETWEEN 3 AND 120)),
  CONSTRAINT subscription_contact_change_exception_reason_bounded
    CHECK ((exception_reason IS NULL) OR (length(exception_reason) BETWEEN 10 AND 1000)),
  CONSTRAINT subscription_contact_change_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT subscription_contact_change_scope_uq UNIQUE (hotel_id, request_id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX subscription_contact_change_open_uq
  ON platform.subscription_contact_change_request (subscription_id)
  WHERE state = ANY (ARRAY['AWAITING_OLD_PHONE'::text, 'AWAITING_NEW_PHONE'::text]);
--> statement-breakpoint

-- doc 14 §2.3: six digits, five minutes, five attempts, sixty seconds between
-- sends, and a new code invalidating the one before it.
--
-- The code itself is a versioned keyed digest bound to its purpose, never
-- plaintext (CLAUDE.md §8), and the attempt count is a column so the budget is
-- a database fact rather than a service convention.
CREATE TABLE platform.subscription_contact_code (
  code_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id           uuid NOT NULL,
  request_id         uuid NOT NULL,
  challenge          text NOT NULL,
  phone              text NOT NULL,
  code_hash          text NOT NULL,
  code_key_version   text NOT NULL,
  attempts           integer NOT NULL DEFAULT 0,
  max_attempts       integer NOT NULL DEFAULT 5,
  is_current         boolean NOT NULL DEFAULT true,
  issued_at          timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  consumed_at        timestamptz,
  superseded_at      timestamptz,
  CONSTRAINT subscription_contact_code_request_fkey FOREIGN KEY (hotel_id, request_id)
    REFERENCES platform.subscription_contact_change_request (hotel_id, request_id)
    ON DELETE RESTRICT,
  CONSTRAINT subscription_contact_code_challenge_known
    CHECK (challenge = ANY (ARRAY['OLD_PHONE'::text, 'NEW_PHONE'::text])),
  CONSTRAINT subscription_contact_code_phone_shape CHECK (phone ~ '^\+976[0-9]{8}$'::text),
  CONSTRAINT subscription_contact_code_hash_shape CHECK (code_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT subscription_contact_code_attempts_bounded
    CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT subscription_contact_code_max_attempts_known CHECK (max_attempts = 5),
  CONSTRAINT subscription_contact_code_expiry_after_issue CHECK (expires_at > issued_at),
  CONSTRAINT subscription_contact_code_current_is_live
    CHECK (is_current = (consumed_at IS NULL AND superseded_at IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX subscription_contact_code_current_uq
  ON platform.subscription_contact_code (request_id, challenge)
  WHERE is_current IS TRUE;
--> statement-breakpoint

-- Every provisioned subscription has a confirmed contact from the moment it
-- exists, seeded from the number the applicant nominated on the application
-- (doc 15 §2.1's `subscription_contact_phone`, doc 14 §5.1).
--
-- A trigger rather than a line in the provisioning wrapper: the invariant then
-- holds for every path that could ever create a subscription, including one a
-- later phase adds. The owner link is written immediately before the
-- subscription inside `platform.provision_paid_hotel`, which is what makes the
-- application reachable here.
--
-- A number that is not a Mongolian eight-digit one seeds nothing rather than
-- being coerced: the subscription then has no confirmed contact, the SMS
-- preview reports it as excluded, and somebody confirms one deliberately.
CREATE OR REPLACE FUNCTION platform.normalise_contact_phone(p_phone text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN compact ~ '^\+976[0-9]{8}$' THEN compact
           WHEN compact ~ '^976[0-9]{8}$'   THEN '+' || compact
           WHEN compact ~ '^[0-9]{8}$'      THEN '+976' || compact
           ELSE NULL
         END
    FROM (SELECT pg_catalog.regexp_replace(COALESCE(p_phone, ''), '[^0-9+]', '', 'g')
                   AS compact) AS normalised
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.seed_subscription_contact()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_phone text;
BEGIN
  SELECT platform.normalise_contact_phone(a.subscription_contact_phone)
    INTO v_phone
    FROM platform.hotel_owner_link l
    JOIN platform.onboarding_application a ON a.application_id = l.application_id
   WHERE l.hotel_id = NEW.hotel_id;

  IF v_phone IS NULL THEN
    RETURN NEW;
  END IF;

  INSERT INTO platform.subscription_contact (hotel_id, subscription_id, phone, source)
  VALUES (NEW.hotel_id, NEW.subscription_id, v_phone, 'PROVISIONING')
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hotel_subscription_seed_contact
  AFTER INSERT ON platform.hotel_subscription
  FOR EACH ROW EXECUTE FUNCTION platform.seed_subscription_contact();
--> statement-breakpoint

-- The subscriptions that already exist get the same seed, from the same source.
INSERT INTO platform.subscription_contact (hotel_id, subscription_id, phone, source)
SELECT s.hotel_id, s.subscription_id,
       platform.normalise_contact_phone(a.subscription_contact_phone), 'PROVISIONING'
  FROM platform.hotel_subscription s
  JOIN platform.hotel_owner_link l ON l.hotel_id = s.hotel_id
  JOIN platform.onboarding_application a ON a.application_id = l.application_id
 WHERE platform.normalise_contact_phone(a.subscription_contact_phone) IS NOT NULL
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- =====================================================================
-- Suspension
-- =====================================================================

-- doc 14 §4.1 / `OPS-DEC-016`. Append-only, and it carries `expires_at` at the
-- moment of the decision on purpose: the rule that suspension never pauses or
-- extends the calendar is asserted by comparing two events rather than by
-- trusting that no code path moved the date.
CREATE TABLE platform.subscription_suspension_event (
  event_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id             uuid NOT NULL,
  subscription_id      uuid NOT NULL,
  action               text NOT NULL,
  reason_code          text NOT NULL,
  note                 text NOT NULL,
  actor_account_id     uuid NOT NULL,
  suspended_before     boolean NOT NULL,
  suspended_after      boolean NOT NULL,
  starts_at_snapshot   timestamptz NOT NULL,
  expires_at_snapshot  timestamptz NOT NULL,
  sessions_revoked     integer NOT NULL DEFAULT 0,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_suspension_event_subscription_fkey
    FOREIGN KEY (hotel_id, subscription_id)
    REFERENCES platform.hotel_subscription (hotel_id, subscription_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_suspension_event_actor_fkey FOREIGN KEY (actor_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_suspension_event_action_known
    CHECK (action = ANY (ARRAY['SUSPEND'::text, 'REACTIVATE'::text])),
  -- Every event is a real transition: an idempotent re-suspend writes nothing.
  CONSTRAINT subscription_suspension_event_is_a_transition
    CHECK (suspended_before <> suspended_after),
  CONSTRAINT subscription_suspension_event_action_matches
    CHECK (suspended_after = (action = 'SUSPEND'::text)),
  CONSTRAINT subscription_suspension_event_reason_code_shape
    CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{2,39}$'::text),
  CONSTRAINT subscription_suspension_event_note_bounded
    CHECK (length(note) BETWEEN 10 AND 1000),
  CONSTRAINT subscription_suspension_event_sessions_non_negative CHECK (sessions_revoked >= 0)
);
--> statement-breakpoint
CREATE INDEX subscription_suspension_event_subscription_idx
  ON platform.subscription_suspension_event (subscription_id, occurred_at DESC);
--> statement-breakpoint

-- `OPS-DEC-016`: a suspension is an access override, not a billing event.
--
-- Phase 05's guard required `billing_revision` to increase on **every** update,
-- which was right while every update was a billing one. A suspension is not:
-- bumping the billing revision would stale an outstanding renewal quote whose
-- `quoted_billing_revision` names the current one, so suspending a hotel would
-- silently invalidate a quote it had already been given.
--
-- The rule becomes the one that was always meant: the billing revision must
-- increase when a billing-bearing column moves, and may never fall otherwise.
-- Everything else the guard enforced is unchanged.
CREATE OR REPLACE FUNCTION platform.hotel_subscription_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_billing_changed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a subscription is never hard deleted' USING ERRCODE = '42501';
  END IF;

  IF NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.timezone IS DISTINCT FROM OLD.timezone THEN
    RAISE EXCEPTION 'a subscription identity is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.starts_at < OLD.starts_at THEN
    RAISE EXCEPTION 'starts_at never moves backwards (was %, offered %)',
      OLD.starts_at, NEW.starts_at USING ERRCODE = '42501';
  END IF;

  IF NEW.expires_at < OLD.expires_at THEN
    RAISE EXCEPTION 'expires_at never moves backwards (was %, offered %)',
      OLD.expires_at, NEW.expires_at USING ERRCODE = '22023';
  END IF;

  IF platform.package_rank(NEW.package_floor) < platform.package_rank(OLD.package_floor) THEN
    RAISE EXCEPTION 'the package floor never falls (%.. offered %) — there is no downgrade (LIFE-DEC-001)',
      OLD.package_floor, NEW.package_floor USING ERRCODE = '42501';
  END IF;
  IF platform.package_rank(NEW.effective_package)
     < platform.package_rank(OLD.effective_package) THEN
    RAISE EXCEPTION 'the effective package never falls (%.. offered %) — there is no downgrade (LIFE-DEC-001)',
      OLD.effective_package, NEW.effective_package USING ERRCODE = '42501';
  END IF;

  v_billing_changed :=
       NEW.starts_at IS DISTINCT FROM OLD.starts_at
    OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
    OR NEW.effective_package IS DISTINCT FROM OLD.effective_package
    OR NEW.package_floor IS DISTINCT FROM OLD.package_floor
    OR NEW.term_months IS DISTINCT FROM OLD.term_months
    OR NEW.pending_upgrade_package IS DISTINCT FROM OLD.pending_upgrade_package
    OR NEW.pending_upgrade_effective_at IS DISTINCT FROM OLD.pending_upgrade_effective_at;

  IF v_billing_changed THEN
    IF NEW.billing_revision <= OLD.billing_revision THEN
      RAISE EXCEPTION 'billing_revision must increase (was %, offered %)',
        OLD.billing_revision, NEW.billing_revision USING ERRCODE = '40001';
    END IF;
  ELSIF NEW.billing_revision < OLD.billing_revision THEN
    RAISE EXCEPTION 'billing_revision never falls (was %, offered %)',
      OLD.billing_revision, NEW.billing_revision USING ERRCODE = '40001';
  END IF;

  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;

  IF OLD.pending_upgrade_package IS NOT NULL
     AND NEW.pending_upgrade_package IS NOT NULL THEN
    IF platform.package_rank(NEW.pending_upgrade_package)
       < platform.package_rank(OLD.pending_upgrade_package) THEN
      RAISE EXCEPTION 'a paid pending upgrade target is only ever raised' USING ERRCODE = '42501';
    END IF;
    IF NEW.pending_upgrade_effective_at IS DISTINCT FROM OLD.pending_upgrade_effective_at THEN
      RAISE EXCEPTION 'an incremental second upgrade inherits the original effective boundary'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- =====================================================================
-- The reconciliation vocabulary and its evidence
-- =====================================================================

-- `OPS-DEC-017` names four terminal outcomes; Phase 05 implemented three under
-- names of its own and required only a note. Phase 19 owns the decision, so the
-- vocabulary becomes doc 14 §4.2's, `CHARGEBACK_LINKED` is added, and the
-- provider/bank/finance reference the document requires becomes a column beside
-- the note rather than something an operator was trusted to put in the note.
--
-- The rename is a pure renaming of a closed vocabulary. The reference cannot be
-- backfilled, because there is nothing truthful to backfill it with — so a
-- database that already holds a closed case stops this migration and asks a
-- human, rather than acquiring an invented reference.
DO $$
DECLARE
  v_closed integer;
BEGIN
  SELECT (SELECT count(*) FROM platform.onboarding_payment_attempt
           WHERE reconciliation_outcome IS NOT NULL)
       + (SELECT count(*) FROM platform.subscription_billing_intent
           WHERE reconciliation_outcome IS NOT NULL)
    INTO v_closed;
  IF v_closed > 0 THEN
    RAISE EXCEPTION
      'migration 0020 cannot add the mandatory reconciliation reference: % case(s) are already closed and have no reference to carry',
      v_closed
      USING ERRCODE = '22023';
  END IF;
END;
$$;
--> statement-breakpoint

ALTER TABLE platform.onboarding_payment_attempt ADD COLUMN reconciliation_reference text;
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent ADD COLUMN reconciliation_reference text;
--> statement-breakpoint

ALTER TABLE platform.onboarding_payment_attempt
  DROP CONSTRAINT onboarding_payment_attempt_reconciliation_outcome_known;
--> statement-breakpoint
ALTER TABLE platform.onboarding_payment_attempt
  ADD CONSTRAINT onboarding_payment_attempt_reconciliation_outcome_known
  CHECK ((reconciliation_outcome IS NULL)
         OR (reconciliation_outcome = ANY (ARRAY['PROVIDER_STATUS_CORRECTED_NOT_PAID'::text,
                                                 'DUPLICATE_OR_SYSTEM_PAYMENT_EXTERNAL_REVERSAL'::text,
                                                 'CHARGEBACK_LINKED'::text,
                                                 'FINANCE_EXCEPTION_CLOSED'::text])));
--> statement-breakpoint
ALTER TABLE platform.onboarding_payment_attempt
  DROP CONSTRAINT onboarding_payment_attempt_reconciled_complete;
--> statement-breakpoint
-- All five together, or none of them: an outcome with no decider, no note or no
-- reference is not a closed case (`OPS-DEC-017`).
ALTER TABLE platform.onboarding_payment_attempt
  ADD CONSTRAINT onboarding_payment_attempt_reconciled_complete
  CHECK (num_nonnulls(reconciliation_outcome, reconciled_by_account_id, reconciled_at,
                      reconciliation_reason, reconciliation_reference)
         = ANY (ARRAY[0, 5]));
--> statement-breakpoint
ALTER TABLE platform.onboarding_payment_attempt
  ADD CONSTRAINT onboarding_payment_attempt_reconciliation_evidence_bounded
  CHECK (((reconciliation_reference IS NULL)
          OR (length(reconciliation_reference) BETWEEN 3 AND 120))
         AND ((reconciliation_reason IS NULL)
              OR (length(reconciliation_reason) BETWEEN 10 AND 1000)));
--> statement-breakpoint

ALTER TABLE platform.subscription_billing_intent
  DROP CONSTRAINT subscription_billing_intent_reconciliation_outcome_known;
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent
  ADD CONSTRAINT subscription_billing_intent_reconciliation_outcome_known
  CHECK ((reconciliation_outcome IS NULL)
         OR (reconciliation_outcome = ANY (ARRAY['PROVIDER_STATUS_CORRECTED_NOT_PAID'::text,
                                                 'DUPLICATE_OR_SYSTEM_PAYMENT_EXTERNAL_REVERSAL'::text,
                                                 'CHARGEBACK_LINKED'::text,
                                                 'FINANCE_EXCEPTION_CLOSED'::text])));
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent
  DROP CONSTRAINT subscription_billing_intent_reconciled_complete;
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent
  ADD CONSTRAINT subscription_billing_intent_reconciled_complete
  CHECK (num_nonnulls(reconciliation_outcome, reconciled_by_account_id, reconciled_at,
                      reconciliation_reason, reconciliation_reference)
         = ANY (ARRAY[0, 5]));
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent
  ADD CONSTRAINT subscription_billing_intent_reconciliation_evidence_bounded
  CHECK (((reconciliation_reference IS NULL)
          OR (length(reconciliation_reference) BETWEEN 3 AND 120))
         AND ((reconciliation_reason IS NULL)
              OR (length(reconciliation_reason) BETWEEN 10 AND 1000)));
--> statement-breakpoint

-- =====================================================================
-- Operation-initiated password reset
-- =====================================================================

-- doc 14 §2.1 / `OPS-DEC-008`: the same durable queue a self-service request
-- and a Hotel Admin's request already use, with a third initiator. One delivery
-- mechanism carries all three, so an Operation user cannot produce a live link
-- by another route — and the attribution travels with the entry.
ALTER TABLE platform.password_reset_intake
  DROP CONSTRAINT password_reset_intake_initiator_known;
--> statement-breakpoint
ALTER TABLE platform.password_reset_intake
  ADD CONSTRAINT password_reset_intake_initiator_known
  CHECK (initiated_by = ANY (ARRAY['self'::text, 'hotel_admin'::text, 'operation'::text]));
--> statement-breakpoint
ALTER TABLE platform.password_reset_request
  DROP CONSTRAINT password_reset_request_initiator_known;
--> statement-breakpoint
ALTER TABLE platform.password_reset_request
  ADD CONSTRAINT password_reset_request_initiator_known
  CHECK (initiated_by = ANY (ARRAY['self'::text, 'hotel_admin'::text, 'operation'::text]));
--> statement-breakpoint

-- =====================================================================
-- SMS: the tariff, the preview, the job and its recipient messages
-- =====================================================================

-- doc 14 §5.3: the estimated cost follows the CallPro agreement's tariff.
-- `EXT-05` has produced no agreement, so this table is empty and the estimate
-- is absent — shown as "боломжтой бол" rather than as an invented number
-- (doc 14 §5.4). Like the commission contract of Phase 14, a row reaches it
-- through the restricted configuration principal and never through the API.
CREATE TABLE platform.sms_tariff (
  tariff_id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider                text NOT NULL,
  price_per_segment_mnt   bigint NOT NULL,
  currency                text NOT NULL DEFAULT 'MNT',
  agreement_reference     text NOT NULL,
  effective_from          timestamptz NOT NULL,
  effective_to            timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_tariff_provider_known CHECK (provider = 'CALLPRO'::text),
  CONSTRAINT sms_tariff_currency_known CHECK (currency = 'MNT'::text),
  CONSTRAINT sms_tariff_price_positive CHECK (price_per_segment_mnt > 0),
  CONSTRAINT sms_tariff_window_ordered
    CHECK ((effective_to IS NULL) OR (effective_to > effective_from)),
  CONSTRAINT sms_tariff_reference_bounded CHECK (length(agreement_reference) BETWEEN 3 AND 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX sms_tariff_live_uq
  ON platform.sms_tariff (provider)
  WHERE effective_to IS NULL;
--> statement-breakpoint

-- doc 14 §5.4 / `OPS-DEC-010`: the preview is the thing that is confirmed.
--
-- `body_hash` and `recipient_hash` are what make step 6 mean anything: if the
-- text or the resolved recipient set has moved since the preview was computed,
-- the confirmation is refused and a new preview is required. Without them
-- "confirm this preview" would be "send whatever the filter matches now".
CREATE TABLE platform.sms_preview (
  preview_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by_account_id  uuid NOT NULL,
  body                   text NOT NULL,
  body_hash              text NOT NULL,
  filter_snapshot        jsonb NOT NULL,
  recipient_hash         text NOT NULL,
  recipient_count        integer NOT NULL,
  excluded_count         integer NOT NULL,
  segments_per_recipient integer NOT NULL,
  total_segments         integer NOT NULL,
  estimated_cost_mnt     bigint,
  tariff_id              uuid,
  created_at             timestamptz NOT NULL DEFAULT now(),
  expires_at             timestamptz NOT NULL,
  consumed_at            timestamptz,
  CONSTRAINT sms_preview_author_fkey FOREIGN KEY (created_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT sms_preview_tariff_fkey FOREIGN KEY (tariff_id)
    REFERENCES platform.sms_tariff (tariff_id) ON DELETE RESTRICT,
  -- doc 14 §5.3: one to three hundred characters, counted after trimming.
  CONSTRAINT sms_preview_body_bounded CHECK (length(btrim(body)) BETWEEN 1 AND 300),
  CONSTRAINT sms_preview_body_is_trimmed CHECK (body = btrim(body)),
  CONSTRAINT sms_preview_hash_shape
    CHECK (body_hash ~ '^[0-9a-f]{64}$'::text AND recipient_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT sms_preview_counts_non_negative
    CHECK (recipient_count >= 0 AND excluded_count >= 0 AND segments_per_recipient >= 0),
  CONSTRAINT sms_preview_total_is_product
    CHECK (total_segments = recipient_count * segments_per_recipient),
  -- An estimate exists exactly when a tariff was in force when it was computed.
  CONSTRAINT sms_preview_cost_needs_a_tariff
    CHECK (num_nonnulls(estimated_cost_mnt, tariff_id) = ANY (ARRAY[0, 2])),
  CONSTRAINT sms_preview_cost_non_negative
    CHECK ((estimated_cost_mnt IS NULL) OR (estimated_cost_mnt >= 0)),
  CONSTRAINT sms_preview_expiry_after_creation CHECK (expires_at > created_at)
);
--> statement-breakpoint

-- doc 14 §6: the send history. A job exists only because somebody confirmed a
-- preview, which is why `confirmed_by_account_id` is `NOT NULL` — there is no
-- shape here for a job a scheduler created (`OPS-DEC-010`).
CREATE TABLE platform.sms_send_job (
  job_id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  preview_id             uuid NOT NULL,
  state                  text NOT NULL DEFAULT 'CONFIRMED',
  body                   text NOT NULL,
  filter_snapshot        jsonb NOT NULL,
  recipient_count        integer NOT NULL,
  excluded_count         integer NOT NULL,
  total_segments         integer NOT NULL,
  estimated_cost_mnt     bigint,
  confirmed_by_account_id uuid NOT NULL,
  confirmed_at           timestamptz NOT NULL DEFAULT now(),
  dispatched_at          timestamptz,
  provider_reference     text,
  last_error             text,
  revision               integer NOT NULL DEFAULT 0,
  CONSTRAINT sms_send_job_preview_fkey FOREIGN KEY (preview_id)
    REFERENCES platform.sms_preview (preview_id) ON DELETE RESTRICT,
  CONSTRAINT sms_send_job_actor_fkey FOREIGN KEY (confirmed_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT sms_send_job_state_known
    CHECK (state = ANY (ARRAY['CONFIRMED'::text, 'DISPATCHED'::text, 'FAILED'::text])),
  CONSTRAINT sms_send_job_dispatched_has_time
    CHECK ((state = 'CONFIRMED'::text) = (dispatched_at IS NULL)),
  CONSTRAINT sms_send_job_body_bounded CHECK (length(btrim(body)) BETWEEN 1 AND 300),
  CONSTRAINT sms_send_job_counts_non_negative
    CHECK (recipient_count >= 0 AND excluded_count >= 0 AND total_segments >= 0),
  CONSTRAINT sms_send_job_revision_non_negative CHECK (revision >= 0),
  -- One job per preview: a repeated confirmation finds this row rather than
  -- creating a second job over the same recipients (doc 14 §5.5).
  CONSTRAINT sms_send_job_preview_uq UNIQUE (preview_id)
);
--> statement-breakpoint

-- doc 14 §3.1: the counting unit is the recipient message, not the job. And
-- doc 14 §5.5: one phone receives one message per job, which is a unique index.
CREATE TABLE platform.sms_recipient_message (
  message_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id               uuid NOT NULL,
  hotel_id             uuid NOT NULL,
  subscription_id      uuid NOT NULL,
  phone                text NOT NULL,
  segments             integer NOT NULL,
  state                text NOT NULL DEFAULT 'PENDING',
  provider_message_id  text,
  failure_code         text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  state_changed_at     timestamptz NOT NULL DEFAULT now(),
  revision             integer NOT NULL DEFAULT 0,
  CONSTRAINT sms_recipient_message_job_fkey FOREIGN KEY (job_id)
    REFERENCES platform.sms_send_job (job_id) ON DELETE RESTRICT,
  CONSTRAINT sms_recipient_message_phone_shape CHECK (phone ~ '^\+976[0-9]{8}$'::text),
  CONSTRAINT sms_recipient_message_segments_positive CHECK (segments >= 1),
  CONSTRAINT sms_recipient_message_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'SENT'::text,
                              'DELIVERED'::text, 'FAILED'::text])),
  -- A message the provider has accepted carries the provider's id for it; one
  -- that never reached the provider does not.
  CONSTRAINT sms_recipient_message_sent_has_provider_id
    CHECK ((state = ANY (ARRAY['SENT'::text, 'DELIVERED'::text]))
           <= (provider_message_id IS NOT NULL)),
  CONSTRAINT sms_recipient_message_failure_shape
    CHECK ((failure_code IS NULL) OR (state = 'FAILED'::text)),
  CONSTRAINT sms_recipient_message_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT sms_recipient_message_job_phone_uq UNIQUE (job_id, phone)
);
--> statement-breakpoint
CREATE UNIQUE INDEX sms_recipient_message_provider_uq
  ON platform.sms_recipient_message (provider_message_id)
  WHERE provider_message_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX sms_recipient_message_month_idx
  ON platform.sms_recipient_message (created_at, state);
--> statement-breakpoint

-- doc 14 §5.5: a repeated provider answer must not break one message's history.
-- Append-only, forward-only, and the forward-only part is a trigger below.
CREATE TABLE platform.sms_message_event (
  event_id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id           uuid NOT NULL,
  state                text NOT NULL,
  source               text NOT NULL,
  provider_message_id  text,
  detail               text,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sms_message_event_message_fkey FOREIGN KEY (message_id)
    REFERENCES platform.sms_recipient_message (message_id) ON DELETE RESTRICT,
  CONSTRAINT sms_message_event_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'SENT'::text,
                              'DELIVERED'::text, 'FAILED'::text])),
  CONSTRAINT sms_message_event_source_known
    CHECK (source = ANY (ARRAY['CONFIRMATION'::text, 'PROVIDER_SEND'::text,
                               'PROVIDER_STATUS_QUERY'::text]))
);
--> statement-breakpoint
CREATE INDEX sms_message_event_message_idx
  ON platform.sms_message_event (message_id, event_id);
--> statement-breakpoint

-- Forward only. `DELIVERED` and `FAILED` are terminal, so a late or duplicated
-- status query cannot walk a message backwards.
CREATE OR REPLACE FUNCTION platform.sms_message_state_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_rank  integer;
  v_next  integer;
BEGIN
  IF NEW.state = OLD.state THEN RETURN NEW; END IF;
  v_rank := CASE OLD.state WHEN 'PENDING' THEN 0 WHEN 'SENT' THEN 1 ELSE 2 END;
  v_next := CASE NEW.state WHEN 'PENDING' THEN 0 WHEN 'SENT' THEN 1 ELSE 2 END;
  IF v_next <= v_rank THEN
    RAISE EXCEPTION 'sms message % cannot move from % to %', NEW.message_id, OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sms_recipient_message_forward_only
  BEFORE UPDATE ON platform.sms_recipient_message
  FOR EACH ROW EXECUTE FUNCTION platform.sms_message_state_guard();
--> statement-breakpoint
CREATE TRIGGER sms_message_event_append_only
  BEFORE UPDATE OR DELETE ON platform.sms_message_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER subscription_suspension_event_append_only
  BEFORE UPDATE OR DELETE ON platform.subscription_suspension_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER subscription_contact_no_delete
  BEFORE DELETE ON platform.subscription_contact
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- A contact revision is written once and superseded once. Its phone, its
-- subscription and its provenance never change, so the only update it accepts
-- is the one that ends it.
CREATE OR REPLACE FUNCTION platform.subscription_contact_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.is_current IS FALSE THEN
    RAISE EXCEPTION 'subscription contact % is already superseded', OLD.contact_id
      USING ERRCODE = '22023';
  END IF;
  IF NEW.phone IS DISTINCT FROM OLD.phone
     OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.change_request_id IS DISTINCT FROM OLD.change_request_id
     OR NEW.changed_by_account_id IS DISTINCT FROM OLD.changed_by_account_id
     OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
    RAISE EXCEPTION 'subscription contact % is immutable except for being superseded',
      OLD.contact_id USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER subscription_contact_supersede_only
  BEFORE UPDATE ON platform.subscription_contact
  FOR EACH ROW EXECUTE FUNCTION platform.subscription_contact_guard();
--> statement-breakpoint

-- =====================================================================
-- Row level security
-- =====================================================================

-- The tenant tables. `subscription_contact` and its codes are the hotel's own
-- and are reached only in the hotel's scope; the change request and the
-- suspension event additionally carry the realm-gated policy Phase 05
-- established, because the decision that was permitted must be the decision
-- that commits, in one transaction (Phase 05 remediation 2, finding 5).
ALTER TABLE platform.subscription_contact ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_contact FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.subscription_contact
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY provisioning_seed ON platform.subscription_contact
  FOR INSERT TO prsystem_maintenance_fn
  WITH CHECK (source = 'PROVISIONING'::text);
--> statement-breakpoint

ALTER TABLE platform.subscription_contact_code ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_contact_code FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.subscription_contact_code
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

ALTER TABLE platform.subscription_contact_change_request ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_contact_change_request FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.subscription_contact_change_request
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
-- doc 14 §2.3: the Super Admin's exception is approved in the Operation realm,
-- and this is the row it is approved on.
CREATE POLICY operation_review ON platform.subscription_contact_change_request
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

ALTER TABLE platform.subscription_suspension_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_suspension_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.subscription_suspension_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY operation_review ON platform.subscription_suspension_event
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

-- `OPS-DEC-016`: suspension is written on the authoritative subscription row,
-- by the Super Admin, inside the transaction the pipeline authorized.
CREATE POLICY operation_review ON platform.hotel_subscription
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

-- The Operation realm's own tables. Their isolation is the realm rather than a
-- tenant: an SMS job spans hotels by definition, and a recipient message's
-- `hotel_id` says who was written to, not whose row it is.
ALTER TABLE platform.sms_preview ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.sms_preview FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY operation_realm_only ON platform.sms_preview
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

ALTER TABLE platform.sms_send_job ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.sms_send_job FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY operation_realm_only ON platform.sms_send_job
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

ALTER TABLE platform.sms_recipient_message ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.sms_recipient_message FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY operation_realm_only ON platform.sms_recipient_message
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

ALTER TABLE platform.sms_message_event ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.sms_message_event FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY operation_realm_only ON platform.sms_message_event
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

-- =====================================================================
-- Runtime grants
-- =====================================================================

GRANT SELECT, INSERT, UPDATE ON platform.operation_totp_factor            TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.operation_account_enrolment      TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.account_recovery_request         TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.subscription_contact             TO prsystem_api;
--> statement-breakpoint
-- The provisioning seed runs inside `platform.provision_paid_hotel`, whose
-- owner is the login-less function owner. It may write the seed shape and
-- nothing else: a `CONTACT_CHANGE` revision is refused by the policy below.
GRANT INSERT ON platform.subscription_contact TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.subscription_contact_change_request TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.subscription_contact_code        TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.subscription_suspension_event    TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.sms_preview                      TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.sms_send_job                     TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.sms_recipient_message            TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.sms_message_event                TO prsystem_api;
--> statement-breakpoint
-- The tariff is configuration. The API reads it to estimate a cost and can
-- never write one (doc 14 §5.3, `EXT-05`).
GRANT SELECT                 ON platform.sms_tariff                       TO prsystem_api;
--> statement-breakpoint

-- =====================================================================
-- The Operation dashboard's resolvers
-- =====================================================================

-- doc 14 §2 lets an Operation account see every hotel's approved subscription
-- information and nothing else. Reading it directly would need a policy on
-- `hotel_profile`, `hotel_owner_link` and `hotel_admin_activation` admitting
-- the realm — and `hotel_admin_activation` holds the registered address in
-- full, which doc 14 §3.2 says an operator may never read.
--
-- So the dashboard reads through `SECURITY DEFINER` functions that mask before
-- they return. The masking is not a formatting choice made in the application:
-- the unmasked address is never sent to it.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.mask_email(p_email text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
           WHEN pg_catalog.strpos(p_email, '@') <= 1
             THEN pg_catalog.repeat('*', greatest(pg_catalog.length(p_email), 1))
           ELSE pg_catalog.substr(p_email, 1, 1)
                || pg_catalog.repeat('*', pg_catalog.strpos(p_email, '@') - 2)
                || pg_catalog.substr(p_email, pg_catalog.strpos(p_email, '@'))
         END
$$;
--> statement-breakpoint

-- The rows the resolvers must reach, stated as the rule rather than as `true`
-- where a rule exists: a provisioned hotel's subscription, its profile, its
-- owner, its primary admin activation and its current contact.
GRANT SELECT ON platform.hotel_subscription, platform.hotel_owner_link,
                platform.hotel_admin_activation, platform.subscription_contact,
                platform.onboarding_application, platform.subscription_owner,
                platform.onboarding_payment_attempt, platform.subscription_billing_intent
  TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.password_reset_intake TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT, UPDATE ON platform.session_scope_grant TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT, UPDATE ON platform.staff_membership TO prsystem_maintenance_fn;
--> statement-breakpoint

CREATE POLICY operation_dashboard_read ON platform.hotel_subscription
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY operation_dashboard_read ON platform.hotel_owner_link
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY operation_dashboard_read ON platform.hotel_admin_activation
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY operation_dashboard_read ON platform.subscription_contact
  FOR SELECT TO prsystem_maintenance_fn USING (is_current IS TRUE);
--> statement-breakpoint
CREATE POLICY operation_suspension_read ON platform.staff_membership
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY operation_suspension_write ON platform.staff_membership
  FOR UPDATE TO prsystem_maintenance_fn USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY operation_suspension_read ON platform.session_scope_grant
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY operation_suspension_write ON platform.session_scope_grant
  FOR UPDATE TO prsystem_maintenance_fn USING (true) WITH CHECK (true);
--> statement-breakpoint

-- `OPS-DEC-014`: the five status cards, the three package cards and the two
-- counts that are deliberately outside the total.
--
-- One statement, one `as_of`, so the partition cannot be assembled from figures
-- taken at different instants. The five statuses are `CASE` arms of one
-- expression, which is what makes them mutually exclusive by construction
-- rather than by five predicates that happen not to overlap.
CREATE OR REPLACE FUNCTION platform.operation_kpi(p_as_of timestamptz DEFAULT NULL)
RETURNS TABLE (
  as_of                timestamptz,
  total_hotels         bigint,
  status_active        bigint,
  status_expiring_soon bigint,
  status_grace         bigint,
  status_expired       bigint,
  status_suspended     bigint,
  package_p20          bigint,
  package_p25          bigint,
  package_p30          bigint,
  inactive_applications bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH moment AS (SELECT COALESCE(p_as_of, pg_catalog.now()) AS at),
  -- A subscription row exists only for a provisioned hotel (doc 15 §5), so the
  -- population is the table itself; the join to the application is what proves
  -- it rather than what filters it.
  hotels AS (
    SELECT s.effective_package,
           CASE
             WHEN s.suspended_at IS NOT NULL THEN 'SUSPENDED'
             WHEN s.expires_at - m.at > interval '168 hours' THEN 'ACTIVE'
             WHEN s.expires_at > m.at THEN 'EXPIRING_SOON'
             WHEN m.at < s.expires_at + interval '48 hours' THEN 'GRACE'
             ELSE 'EXPIRED'
           END AS status
      FROM platform.hotel_subscription s
     CROSS JOIN moment m
  ),
  -- The SMS counters are deliberately *not* here. Those rows belong to the
  -- Operation realm and are readable by the realm itself, so counting them
  -- through a definer would hand this login-less owner a privilege it does not
  -- need — and the class rule for an Operation-realm table is that only the API
  -- role holds anything on it.
  x AS (SELECT 1)
  SELECT (SELECT at FROM moment),
         (SELECT pg_catalog.count(*) FROM hotels),
         (SELECT pg_catalog.count(*) FROM hotels WHERE status = 'ACTIVE'),
         (SELECT pg_catalog.count(*) FROM hotels WHERE status = 'EXPIRING_SOON'),
         (SELECT pg_catalog.count(*) FROM hotels WHERE status = 'GRACE'),
         (SELECT pg_catalog.count(*) FROM hotels WHERE status = 'EXPIRED'),
         (SELECT pg_catalog.count(*) FROM hotels WHERE status = 'SUSPENDED'),
         (SELECT pg_catalog.count(*) FROM hotels WHERE effective_package = 'P20'),
         (SELECT pg_catalog.count(*) FROM hotels WHERE effective_package = 'P25'),
         (SELECT pg_catalog.count(*) FROM hotels WHERE effective_package = 'P30'),
         -- `OPS-DEC-013`: paid, not provisioned, and outside the total.
         (SELECT pg_catalog.count(*) FROM platform.onboarding_application a
           WHERE a.state = ANY (ARRAY['PAID_PENDING_PROVISIONING'::text, 'PROVISIONING'::text,
                                      'PROVISIONING_FAILED'::text,
                                      'PAID_OWNER_VERIFICATION_REQUIRED'::text]))
    FROM x
$$;
--> statement-breakpoint
ALTER FUNCTION platform.operation_kpi(timestamptz) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.operation_kpi(timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.operation_kpi(timestamptz) TO prsystem_api;
--> statement-breakpoint

-- `OPS-DEC-011` and `OPS-DEC-012`: the thirteen columns, the combined
-- server-side filters, the expiry-ascending default order, and the total the
-- pagination is over.
--
-- The email leaves this function masked. `p_email` is compared against the
-- stored address inside the function, so an operator can confirm an address
-- they already hold and can never read one they do not.
CREATE OR REPLACE FUNCTION platform.operation_subscription_page(
  p_name          text        DEFAULT NULL,
  p_phone         text        DEFAULT NULL,
  p_email         text        DEFAULT NULL,
  p_owner_type    text        DEFAULT NULL,
  p_district      text        DEFAULT NULL,
  p_package       text        DEFAULT NULL,
  p_term_months   integer     DEFAULT NULL,
  p_status        text        DEFAULT NULL,
  p_expires_from  timestamptz DEFAULT NULL,
  p_expires_to    timestamptz DEFAULT NULL,
  p_as_of         timestamptz DEFAULT NULL,
  p_limit         integer     DEFAULT 25,
  p_offset        integer     DEFAULT 0
)
RETURNS TABLE (
  hotel_id         uuid,
  subscription_id  uuid,
  hotel_name       text,
  owner_type       text,
  district         text,
  address_line     text,
  contact_phone    text,
  email_masked     text,
  effective_package text,
  term_months      integer,
  starts_at        timestamptz,
  expires_at       timestamptz,
  suspended_at     timestamptz,
  status           text,
  total_rows       bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH moment AS (SELECT COALESCE(p_as_of, pg_catalog.now()) AS at),
  rows AS (
    SELECT h.hotel_id,
           s.subscription_id,
           h.display_name AS hotel_name,
           l.owner_type,
           p.district,
           p.address_line,
           c.phone AS contact_phone,
           platform.mask_email(a.email_normalized) AS email_masked,
           a.email_normalized AS email_raw,
           s.effective_package,
           s.term_months,
           s.starts_at,
           s.expires_at,
           s.suspended_at,
           CASE
             WHEN s.suspended_at IS NOT NULL THEN 'SUSPENDED'
             WHEN s.expires_at - m.at > interval '168 hours' THEN 'ACTIVE'
             WHEN s.expires_at > m.at THEN 'EXPIRING_SOON'
             WHEN m.at < s.expires_at + interval '48 hours' THEN 'GRACE'
             ELSE 'EXPIRED'
           END AS status
      FROM platform.hotel_subscription s
      JOIN platform.hotel h ON h.hotel_id = s.hotel_id
      JOIN platform.hotel_profile p ON p.hotel_id = s.hotel_id
      JOIN platform.hotel_owner_link l ON l.hotel_id = s.hotel_id
      -- One application per provisioned hotel, so one activation — resolved
      -- laterally rather than by a join, so a second row could never multiply
      -- a hotel into two list entries.
      JOIN LATERAL (SELECT act.email_normalized
                      FROM platform.hotel_admin_activation act
                     WHERE act.hotel_id = s.hotel_id
                     ORDER BY act.created_at, act.activation_id
                     LIMIT 1) a ON true
      LEFT JOIN platform.subscription_contact c
             ON c.subscription_id = s.subscription_id AND c.is_current IS TRUE
     CROSS JOIN moment m
  ),
  filtered AS (
    SELECT * FROM rows r
     WHERE (p_name IS NULL OR r.hotel_name ILIKE '%' || p_name || '%')
       AND (p_phone IS NULL OR r.contact_phone = p_phone)
       AND (p_email IS NULL OR r.email_raw = pg_catalog.lower(pg_catalog.btrim(p_email)))
       AND (p_owner_type IS NULL OR r.owner_type = p_owner_type)
       AND (p_district IS NULL OR r.district = p_district)
       AND (p_package IS NULL OR r.effective_package = p_package)
       AND (p_term_months IS NULL OR r.term_months = p_term_months)
       AND (p_status IS NULL OR r.status = p_status)
       AND (p_expires_from IS NULL OR r.expires_at >= p_expires_from)
       AND (p_expires_to IS NULL OR r.expires_at <= p_expires_to)
  )
  SELECT f.hotel_id, f.subscription_id, f.hotel_name, f.owner_type, f.district, f.address_line,
         f.contact_phone, f.email_masked, f.effective_package, f.term_months, f.starts_at,
         f.expires_at, f.suspended_at, f.status,
         pg_catalog.count(*) OVER () AS total_rows
    FROM filtered f
   -- doc 14 §3.2: soonest to expire first, then the hotel's name, so the order
   -- is total and a page boundary is stable.
   ORDER BY f.expires_at, f.hotel_name, f.hotel_id
   LIMIT least(greatest(p_limit, 1), 100)
  OFFSET greatest(p_offset, 0)
$$;
--> statement-breakpoint
ALTER FUNCTION platform.operation_subscription_page(text, text, text, text, text, text, integer,
  text, timestamptz, timestamptz, timestamptz, integer, integer)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.operation_subscription_page(text, text, text, text, text, text,
  integer, text, timestamptz, timestamptz, timestamptz, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.operation_subscription_page(text, text, text, text, text, text,
  integer, text, timestamptz, timestamptz, timestamptz, integer, integer) TO prsystem_api;
--> statement-breakpoint

-- `OPS-DEC-013`: the applications that are not hotels, in their own queue.
CREATE OR REPLACE FUNCTION platform.operation_application_queue(
  p_group  text    DEFAULT NULL,
  p_limit  integer DEFAULT 25,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  application_id  uuid,
  state           text,
  queue_group     text,
  hotel_name      text,
  owner_type      text,
  district        text,
  package_code    text,
  term_months     integer,
  email_masked    text,
  created_at      timestamptz,
  state_changed_at timestamptz,
  provision_attempts integer,
  total_rows      bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH rows AS (
    SELECT a.application_id,
           a.state,
           CASE
             WHEN a.state = ANY (ARRAY['PAID_PENDING_PROVISIONING'::text, 'PROVISIONING'::text,
                                       'PROVISIONING_FAILED'::text,
                                       'PAID_OWNER_VERIFICATION_REQUIRED'::text])
               THEN 'INACTIVE'
             ELSE 'UNPAID'
           END AS queue_group,
           a.hotel_display_name AS hotel_name,
           a.owner_type,
           a.district,
           a.package_code,
           a.term_months,
           platform.mask_email(a.admin_email_normalized) AS email_masked,
           a.created_at,
           a.state_changed_at,
           a.provision_attempts
      FROM platform.onboarding_application a
     -- A provisioned application is a Hotel from that moment and belongs to
     -- neither group: counting it here and in the hotel KPI is exactly what
     -- `OPS-DEC-013` forbids.
     WHERE a.state <> 'PROVISIONED'::text
  ),
  filtered AS (SELECT * FROM rows r WHERE p_group IS NULL OR r.queue_group = p_group)
  SELECT f.application_id, f.state, f.queue_group, f.hotel_name, f.owner_type, f.district,
         f.package_code, f.term_months, f.email_masked, f.created_at, f.state_changed_at,
         f.provision_attempts, pg_catalog.count(*) OVER () AS total_rows
    FROM filtered f
   ORDER BY f.created_at DESC, f.application_id
   LIMIT least(greatest(p_limit, 1), 100)
  OFFSET greatest(p_offset, 0)
$$;
--> statement-breakpoint
ALTER FUNCTION platform.operation_application_queue(text, integer, integer)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.operation_application_queue(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.operation_application_queue(text, integer, integer)
  TO prsystem_api;
--> statement-breakpoint

-- doc 14 §5.2: the recipients a filter resolves to, deduplicated by the caller.
--
-- One subscription, one contact number, and a hotel with no confirmed contact
-- appears with a NULL phone so the preview can report it as excluded rather
-- than silently omitting it (doc 14 §5.4 step 5).
CREATE OR REPLACE FUNCTION platform.operation_sms_recipients(
  p_hotel_ids    uuid[]      DEFAULT NULL,
  p_package      text        DEFAULT NULL,
  p_status       text        DEFAULT NULL,
  p_expires_from timestamptz DEFAULT NULL,
  p_expires_to   timestamptz DEFAULT NULL,
  p_as_of        timestamptz DEFAULT NULL
)
RETURNS TABLE (
  hotel_id        uuid,
  subscription_id uuid,
  hotel_name      text,
  phone           text,
  status          text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH moment AS (SELECT COALESCE(p_as_of, pg_catalog.now()) AS at),
  rows AS (
    SELECT s.hotel_id,
           s.subscription_id,
           h.display_name AS hotel_name,
           c.phone,
           s.effective_package,
           s.expires_at,
           CASE
             WHEN s.suspended_at IS NOT NULL THEN 'SUSPENDED'
             WHEN s.expires_at - m.at > interval '168 hours' THEN 'ACTIVE'
             WHEN s.expires_at > m.at THEN 'EXPIRING_SOON'
             WHEN m.at < s.expires_at + interval '48 hours' THEN 'GRACE'
             ELSE 'EXPIRED'
           END AS status
      FROM platform.hotel_subscription s
      JOIN platform.hotel h ON h.hotel_id = s.hotel_id
      LEFT JOIN platform.subscription_contact c
             ON c.subscription_id = s.subscription_id AND c.is_current IS TRUE
     CROSS JOIN moment m
  )
  SELECT r.hotel_id, r.subscription_id, r.hotel_name, r.phone, r.status
    FROM rows r
   WHERE (p_hotel_ids IS NULL OR r.hotel_id = ANY (p_hotel_ids))
     AND (p_package IS NULL OR r.effective_package = p_package)
     AND (p_status IS NULL OR r.status = p_status)
     AND (p_expires_from IS NULL OR r.expires_at >= p_expires_from)
     AND (p_expires_to IS NULL OR r.expires_at <= p_expires_to)
   ORDER BY r.hotel_name, r.hotel_id
$$;
--> statement-breakpoint
ALTER FUNCTION platform.operation_sms_recipients(uuid[], text, text, timestamptz, timestamptz,
  timestamptz) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.operation_sms_recipients(uuid[], text, text, timestamptz,
  timestamptz, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.operation_sms_recipients(uuid[], text, text, timestamptz,
  timestamptz, timestamptz) TO prsystem_api;
--> statement-breakpoint

-- doc 14 §4.2: the paid records that did not apply themselves, across both
-- shapes — an onboarding attempt and a subscription billing intent.
CREATE OR REPLACE FUNCTION platform.operation_reconciliation_queue(p_limit integer DEFAULT 50)
RETURNS TABLE (
  subject_kind    text,
  subject_id      uuid,
  hotel_id        uuid,
  application_id  uuid,
  provider        text,
  provider_invoice_id text,
  provider_payment_id text,
  amount_mnt      bigint,
  confirmed_at    timestamptz,
  state           text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT 'ONBOARDING_ATTEMPT'::text, t.attempt_id, NULL::uuid, t.application_id, t.provider,
         t.provider_invoice_id, t.provider_payment_id, t.amount_mnt, t.confirmed_at, t.state
    FROM platform.onboarding_payment_attempt t
   WHERE t.state = 'PAID_REQUIRES_RECONCILIATION'::text
     AND t.reconciliation_outcome IS NULL
  UNION ALL
  SELECT 'SUBSCRIPTION_INTENT'::text, i.intent_id, i.hotel_id, NULL::uuid, i.provider,
         i.provider_invoice_id, i.provider_payment_id, i.amount_mnt, i.confirmed_at, i.state
    FROM platform.subscription_billing_intent i
   WHERE i.state = 'PAID_REQUIRES_RECONCILIATION'::text
     AND i.reconciliation_outcome IS NULL
   ORDER BY 9 NULLS LAST, 2
   LIMIT least(greatest(p_limit, 1), 200)
$$;
--> statement-breakpoint
ALTER FUNCTION platform.operation_reconciliation_queue(integer)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.operation_reconciliation_queue(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.operation_reconciliation_queue(integer) TO prsystem_api;
--> statement-breakpoint

-- `OPS-DEC-008`: the reset the operator initiates and never sees.
--
-- The registered address is read, queued and returned **masked** inside one
-- function, so the address itself never crosses into the application, into a
-- log, into an audit payload or into a response. The operator learns that a
-- link was queued, to a destination they can recognise and cannot read.
CREATE OR REPLACE FUNCTION platform.operation_queue_password_reset(
  p_hotel_id            uuid,
  p_initiator_account_id uuid
)
RETURNS TABLE (intake_id uuid, account_id uuid, email_masked text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_account uuid;
  v_email   text;
  v_intake  uuid;
BEGIN
  SELECT a.account_id, a.email_normalized
    INTO v_account, v_email
    FROM platform.hotel_admin_activation a
   WHERE a.hotel_id = p_hotel_id
   ORDER BY a.created_at, a.activation_id
   LIMIT 1;

  IF v_account IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO platform.password_reset_intake
    (email_normalized, initiated_by, initiated_by_account_id)
  VALUES (v_email, 'operation', p_initiator_account_id)
  RETURNING platform.password_reset_intake.intake_id INTO v_intake;

  RETURN QUERY SELECT v_intake, v_account, platform.mask_email(v_email);
END;
$$;
--> statement-breakpoint
ALTER FUNCTION platform.operation_queue_password_reset(uuid, uuid)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.operation_queue_password_reset(uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.operation_queue_password_reset(uuid, uuid) TO prsystem_api;
--> statement-breakpoint

-- The account a hotel's subscription belongs to, for the surfaces that must
-- name it without reading it (doc 14 §2.1, §2.2).
--
-- The address leaves masked, exactly as it does from the list, so an operator
-- who escalates a lost-access case still cannot read the address they are
-- escalating about.
CREATE OR REPLACE FUNCTION platform.operation_subscription_account(p_hotel_id uuid)
RETURNS TABLE (account_id uuid, email_masked text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.account_id, platform.mask_email(a.email_normalized)
    FROM platform.hotel_admin_activation a
   WHERE a.hotel_id = p_hotel_id
   ORDER BY a.created_at, a.activation_id
   LIMIT 1
$$;
--> statement-breakpoint
ALTER FUNCTION platform.operation_subscription_account(uuid) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.operation_subscription_account(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.operation_subscription_account(uuid) TO prsystem_api;
--> statement-breakpoint

-- `OPS-DEC-016`: a suspension closes the hotel's staff authority at once.
--
-- Not by bumping the account epoch, which would close the same person's
-- sessions in hotels that were never suspended, and not by deleting anything.
-- Every live scope grant in this hotel is revoked and every membership's
-- revision is bumped, which is precisely the pair the authorization pipeline
-- re-reads at commit — so a request authorized a moment earlier loses to this.
CREATE OR REPLACE FUNCTION platform.operation_revoke_hotel_scope(p_hotel_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_revoked integer;
BEGIN
  UPDATE platform.session_scope_grant
     SET revoked_at = pg_catalog.now(), revoked_reason = 'subscription_suspended'
   WHERE hotel_id = p_hotel_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  UPDATE platform.staff_membership
     SET membership_revision = membership_revision + 1
   WHERE hotel_id = p_hotel_id;

  RETURN v_revoked;
END;
$$;
--> statement-breakpoint
ALTER FUNCTION platform.operation_revoke_hotel_scope(uuid) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.operation_revoke_hotel_scope(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.operation_revoke_hotel_scope(uuid) TO prsystem_api;
--> statement-breakpoint

REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
--> statement-breakpoint
