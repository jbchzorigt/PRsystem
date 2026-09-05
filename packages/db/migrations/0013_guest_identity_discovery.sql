-- Public discovery and Guest authentication: the realm a person books from, the
-- phone they prove they hold, the external identity they may link to it, and
-- the photographs without which a hotel is not shown at all.
--
-- Four structural rules run through this migration.
--
-- **A Guest is an account, not a hotel's record.** doc 09 §6.4 keeps the
-- account, the booker and the staying guest apart on purpose. The Guest realm
-- therefore joins `platform.user_account` and `platform.server_session` rather
-- than getting a parallel identity of its own — realms never merge (ADR-0005),
-- but they do share the kernel that issues and revokes sessions.
--
-- **A Guest registers by phone, so an account may hold no email.** The two
-- realms that sign in by email keep their `NOT NULL`; a guest row may carry
-- none, and PostgreSQL's unique index treats those NULLs as distinct
-- (`BK-DEC-002`, doc 09 §6.2).
--
-- **No phone, code or provider subject is ever stored in the clear.** The
-- number is encrypted with a wrapped DEK and looked up by a keyed token in its
-- own scope; the one-time code is a keyed hash; the provider's subject is a
-- keyed token too. None of them may be read back by a query that does not hold
-- the key (CLAUDE.md §8, ADR-0020).
--
-- **Two accounts are never merged on a guess.** doc 09 §6.3: linking an
-- e-Mongolia identity to an existing phone account requires both channels to be
-- confirmed, and the confirmation is a row with its own audit, not a flag.
--
-- docs 09 (`BK-DEC-001`, `BK-DEC-002`), 18 §§7–8, 15 §5.1 (the listing axis this
-- reads); ADR-0005 (realms), ADR-0011 (revision/CAS), ADR-0017 (RLS + roles),
-- ADR-0018 (audit), ADR-0020 (keys and lookup tokens).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- =====================================================================
-- The Guest realm joins the account kernel
-- =====================================================================

ALTER TABLE platform.user_account
  DROP CONSTRAINT user_account_realm_known;
--> statement-breakpoint
ALTER TABLE platform.user_account
  ADD CONSTRAINT user_account_realm_known
    CHECK (realm = ANY (ARRAY['hotel'::text, 'guest'::text, 'operation'::text, 'police'::text]));
--> statement-breakpoint

-- doc 09 §6.2: a Guest signs in with a phone number and a password of their own
-- choosing. Every other realm still requires the email it signs in with, and the
-- shape and lowercase constraints are unchanged — they pass on NULL and refuse
-- anything else.
ALTER TABLE platform.user_account
  ALTER COLUMN email_normalized DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE platform.user_account
  ADD CONSTRAINT user_account_email_required_outside_guest
    CHECK (email_normalized IS NOT NULL OR realm = 'guest'::text);
--> statement-breakpoint

ALTER TABLE platform.server_session
  DROP CONSTRAINT server_session_realm_known;
--> statement-breakpoint
ALTER TABLE platform.server_session
  ADD CONSTRAINT server_session_realm_known
    CHECK (realm = ANY (ARRAY['hotel'::text, 'guest'::text, 'operation'::text, 'police'::text]));
--> statement-breakpoint

-- =====================================================================
-- The Guest account
-- =====================================================================

-- doc 09 §6.2, §6.3: one verified phone number, one primary account. The number
-- itself is encrypted; `phone_token` is the keyed lookup token that makes exact
-- match possible without it (`lookup.guest_phone`).
-- doc 09 §6.1 and §6.2 are two doors into the same realm. A guest who
-- registers by phone holds a proven number; a guest who registers through
-- e-Mongolia holds a provider identity and may hold no number at all. The
-- phone columns are therefore all-or-nothing rather than mandatory, and
-- `registered_via` says which door was used — so `PHONE_OTP` without a proven
-- number is unrepresentable rather than merely unwritten.
CREATE TABLE platform.guest_account (
  account_id             uuid PRIMARY KEY,
  -- Constant, and part of the foreign key: a Guest profile can only ever be
  -- attached to an account whose realm is `guest` (ADR-0005).
  realm                  text NOT NULL DEFAULT 'guest',
  registered_via         text NOT NULL,
  phone_token            text,
  phone_token_key_version text,
  phone_ciphertext       bytea,
  phone_wrapped_dek      bytea,
  phone_key_version      text,
  display_name           text,
  state                  text NOT NULL DEFAULT 'ACTIVE',
  phone_verified_at      timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  revision               integer NOT NULL DEFAULT 0,
  CONSTRAINT guest_account_account_fkey FOREIGN KEY (account_id, realm)
    REFERENCES platform.user_account (account_id, realm) ON DELETE RESTRICT,
  CONSTRAINT guest_account_realm_is_guest CHECK (realm = 'guest'::text),
  CONSTRAINT guest_account_registered_via_known
    CHECK (registered_via = ANY (ARRAY['PHONE_OTP'::text, 'PROVIDER'::text])),
  CONSTRAINT guest_account_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'SUSPENDED'::text, 'CLOSED'::text])),
  CONSTRAINT guest_account_token_shape
    CHECK (phone_token IS NULL OR phone_token ~ '^[0-9a-f]{64}$'::text),
  -- A number is present with everything that proves and protects it, or not at
  -- all: never a token without its ciphertext, nor a ciphertext unverified.
  CONSTRAINT guest_account_phone_all_or_nothing
    CHECK (num_nulls(phone_token, phone_token_key_version, phone_ciphertext,
                     phone_wrapped_dek, phone_key_version, phone_verified_at) IN (0, 6)),
  -- Registering by phone means holding one.
  CONSTRAINT guest_account_phone_registration_has_phone
    CHECK (registered_via <> 'PHONE_OTP'::text OR phone_token IS NOT NULL),
  CONSTRAINT guest_account_display_name_bounded
    CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 120),
  CONSTRAINT guest_account_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- doc 09 §6.3: one verified number, one primary account. Partial, because an
-- account registered through the provider holds none and many such rows must
-- not collide.
CREATE UNIQUE INDEX guest_account_phone_token_uq ON platform.guest_account (phone_token)
  WHERE phone_token IS NOT NULL;
--> statement-breakpoint

-- The identity of a Guest account is written once. A phone number that changes
-- hands is a new verification and a decision by a person, never an UPDATE.
CREATE OR REPLACE FUNCTION platform.guest_account_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.realm IS DISTINCT FROM OLD.realm
     OR NEW.registered_via IS DISTINCT FROM OLD.registered_via
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a guest account identity is immutable (BK-DEC-002)' USING ERRCODE = '42501';
  END IF;
  -- A number already proven is never replaced or withdrawn: a number that
  -- changes hands is a new verification and a decision by a person, never an
  -- UPDATE. An account registered through the provider may gain one exactly
  -- once, by proving it.
  IF OLD.phone_token IS NOT NULL
     AND (NEW.phone_token IS DISTINCT FROM OLD.phone_token
          OR NEW.phone_verified_at IS DISTINCT FROM OLD.phone_verified_at) THEN
    RAISE EXCEPTION 'a proven phone number is immutable (BK-DEC-002)' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  IF OLD.state = 'CLOSED' AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a closed guest account is not reopened' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guest_account_update_guard
  BEFORE UPDATE ON platform.guest_account
  FOR EACH ROW EXECUTE FUNCTION platform.guest_account_guard();
--> statement-breakpoint
CREATE TRIGGER guest_account_no_delete
  BEFORE DELETE ON platform.guest_account
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The one-time code that proves the number
-- =====================================================================

-- doc 09 §6.2: six digits, unguessable, time-limited, attempt-limited. The code
-- is never stored — `code_hash` is a keyed HMAC in the `auth.guest_otp` scope,
-- so a database copy proves nothing and cannot be replayed as any other token.
CREATE TABLE platform.guest_phone_verification (
  verification_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_token       text NOT NULL,
  purpose           text NOT NULL,
  code_hash         text NOT NULL,
  code_key_version  text NOT NULL,
  account_id        uuid,
  state             text NOT NULL DEFAULT 'PENDING',
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL DEFAULT 5,
  sent_at           timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  consumed_at       timestamptz,
  request_ip_hash   text,
  revision          integer NOT NULL DEFAULT 0,
  CONSTRAINT guest_phone_verification_account_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT guest_phone_verification_purpose_known
    CHECK (purpose = ANY (ARRAY['REGISTER'::text, 'SIGN_IN'::text, 'PASSWORD_RESET'::text,
                                'ACCOUNT_LINK'::text])),
  CONSTRAINT guest_phone_verification_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'CONSUMED'::text, 'EXPIRED'::text,
                              'LOCKED'::text])),
  CONSTRAINT guest_phone_verification_token_shape CHECK (phone_token ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT guest_phone_verification_code_shape CHECK (code_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT guest_phone_verification_ip_shape
    CHECK (request_ip_hash IS NULL OR request_ip_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT guest_phone_verification_attempts_bounded
    CHECK (attempts >= 0 AND max_attempts BETWEEN 1 AND 10 AND attempts <= max_attempts),
  CONSTRAINT guest_phone_verification_expiry_after_send CHECK (expires_at > sent_at),
  CONSTRAINT guest_phone_verification_consumed_shape
    CHECK ((state = 'CONSUMED'::text) = (consumed_at IS NOT NULL)),
  CONSTRAINT guest_phone_verification_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- One live code per number and purpose: a resend supersedes, it does not stack.
CREATE UNIQUE INDEX guest_phone_verification_one_pending_uq
  ON platform.guest_phone_verification (phone_token, purpose)
  WHERE state = 'PENDING'::text;
--> statement-breakpoint
CREATE INDEX guest_phone_verification_rate_idx
  ON platform.guest_phone_verification (phone_token, sent_at DESC);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.guest_phone_verification_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.verification_id IS DISTINCT FROM OLD.verification_id
     OR NEW.phone_token IS DISTINCT FROM OLD.phone_token
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.code_hash IS DISTINCT FROM OLD.code_hash
     OR NEW.code_key_version IS DISTINCT FROM OLD.code_key_version
     OR NEW.sent_at IS DISTINCT FROM OLD.sent_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a one-time code and its window are immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'PENDING'::text AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a settled verification is not reopened' USING ERRCODE = '22023';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'attempts never decrease' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guest_phone_verification_update_guard
  BEFORE UPDATE ON platform.guest_phone_verification
  FOR EACH ROW EXECUTE FUNCTION platform.guest_phone_verification_guard();
--> statement-breakpoint
CREATE TRIGGER guest_phone_verification_no_delete
  BEFORE DELETE ON platform.guest_phone_verification
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The external identity, and the link that is never assumed
-- =====================================================================

-- doc 09 §6.1: what e-Mongolia returns is a provider subject, not a person the
-- platform has already met. The link is stored as a keyed token of that subject
-- in its own scope; the raw value is never a column.
CREATE TABLE platform.guest_identity_link (
  link_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider            text NOT NULL,
  subject_token       text NOT NULL,
  subject_key_version text NOT NULL,
  account_id          uuid NOT NULL,
  realm               text NOT NULL DEFAULT 'guest',
  linked_at           timestamptz NOT NULL DEFAULT now(),
  linked_via          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  revision            integer NOT NULL DEFAULT 0,
  CONSTRAINT guest_identity_link_account_fkey FOREIGN KEY (account_id, realm)
    REFERENCES platform.user_account (account_id, realm) ON DELETE RESTRICT,
  CONSTRAINT guest_identity_link_realm_is_guest CHECK (realm = 'guest'::text),
  CONSTRAINT guest_identity_link_provider_known CHECK (provider = 'EMONGOLIA'::text),
  CONSTRAINT guest_identity_link_subject_shape CHECK (subject_token ~ '^[0-9a-f]{64}$'::text),
  -- Either the account was created by this provider, or a person proved both
  -- channels first (doc 09 §6.3). There is no third way in.
  CONSTRAINT guest_identity_link_via_known
    CHECK (linked_via = ANY (ARRAY['PROVIDER_REGISTRATION'::text, 'DUAL_CHANNEL_LINK'::text])),
  CONSTRAINT guest_identity_link_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX guest_identity_link_subject_uq
  ON platform.guest_identity_link (provider, subject_token);
--> statement-breakpoint
CREATE UNIQUE INDEX guest_identity_link_account_uq
  ON platform.guest_identity_link (provider, account_id);
--> statement-breakpoint
CREATE TRIGGER guest_identity_link_append_only
  BEFORE UPDATE OR DELETE ON platform.guest_identity_link
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- doc 09 §6.3: before an e-Mongolia identity joins an existing phone account,
-- both channels are confirmed — the provider's own authentication, and a fresh
-- one-time code on the number the account already holds. The row is the
-- evidence; `CONFIRMED` is unreachable without both.
CREATE TABLE platform.guest_account_link_request (
  request_id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                  uuid NOT NULL,
  realm                       text NOT NULL DEFAULT 'guest',
  provider                    text NOT NULL,
  subject_token               text NOT NULL,
  subject_key_version         text NOT NULL,
  state                       text NOT NULL DEFAULT 'PENDING',
  provider_channel_verified_at timestamptz,
  phone_channel_verified_at   timestamptz,
  verification_id             uuid,
  link_id                     uuid,
  reason                      text,
  requested_at                timestamptz NOT NULL DEFAULT now(),
  expires_at                  timestamptz NOT NULL,
  decided_at                  timestamptz,
  revision                    integer NOT NULL DEFAULT 0,
  CONSTRAINT guest_account_link_request_account_fkey FOREIGN KEY (account_id, realm)
    REFERENCES platform.user_account (account_id, realm) ON DELETE RESTRICT,
  CONSTRAINT guest_account_link_request_verification_fkey FOREIGN KEY (verification_id)
    REFERENCES platform.guest_phone_verification (verification_id) ON DELETE RESTRICT,
  CONSTRAINT guest_account_link_request_link_fkey FOREIGN KEY (link_id)
    REFERENCES platform.guest_identity_link (link_id) ON DELETE RESTRICT,
  CONSTRAINT guest_account_link_request_realm_is_guest CHECK (realm = 'guest'::text),
  CONSTRAINT guest_account_link_request_provider_known CHECK (provider = 'EMONGOLIA'::text),
  CONSTRAINT guest_account_link_request_subject_shape
    CHECK (subject_token ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT guest_account_link_request_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'CONFIRMED'::text, 'REJECTED'::text,
                              'EXPIRED'::text])),
  -- The rule this table exists for.
  CONSTRAINT guest_account_link_request_dual_channel
    CHECK ((state <> 'CONFIRMED'::text)
           OR (provider_channel_verified_at IS NOT NULL
               AND phone_channel_verified_at IS NOT NULL
               AND verification_id IS NOT NULL
               AND link_id IS NOT NULL)),
  CONSTRAINT guest_account_link_request_decided_shape
    CHECK ((state = 'PENDING'::text) = (decided_at IS NULL)),
  CONSTRAINT guest_account_link_request_reason_bounded
    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 300),
  CONSTRAINT guest_account_link_request_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

CREATE UNIQUE INDEX guest_account_link_request_one_pending_uq
  ON platform.guest_account_link_request (provider, subject_token)
  WHERE state = 'PENDING'::text;
--> statement-breakpoint
CREATE INDEX guest_account_link_request_account_idx
  ON platform.guest_account_link_request (account_id, state);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.guest_account_link_request_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.subject_token IS DISTINCT FROM OLD.subject_token
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a link request and the identities it names are immutable (doc 09 §6.3)'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state <> 'PENDING'::text THEN
    RAISE EXCEPTION 'a decided link request is immutable' USING ERRCODE = '42501';
  END IF;
  IF OLD.provider_channel_verified_at IS NOT NULL
     AND NEW.provider_channel_verified_at IS DISTINCT FROM OLD.provider_channel_verified_at THEN
    RAISE EXCEPTION 'a confirmed channel is not re-confirmed' USING ERRCODE = '42501';
  END IF;
  IF OLD.phone_channel_verified_at IS NOT NULL
     AND NEW.phone_channel_verified_at IS DISTINCT FROM OLD.phone_channel_verified_at THEN
    RAISE EXCEPTION 'a confirmed channel is not re-confirmed' USING ERRCODE = '42501';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER guest_account_link_request_update_guard
  BEFORE UPDATE ON platform.guest_account_link_request
  FOR EACH ROW EXECUTE FUNCTION platform.guest_account_link_request_guard();
--> statement-breakpoint
CREATE TRIGGER guest_account_link_request_no_delete
  BEFORE DELETE ON platform.guest_account_link_request
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

-- =====================================================================
-- The photographs a listing cannot be shown without
-- =====================================================================

-- doc 09 §3.2, §3.3 and §5: a hotel card carries a cover image and a room
-- category is only offered with a photograph. The bytes live in private object
-- storage; the row holds the key, never the image.
CREATE TABLE platform.hotel_photo (
  photo_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id              uuid NOT NULL,
  subject_type          text NOT NULL,
  category_id           uuid,
  object_key            text NOT NULL,
  content_type          text NOT NULL,
  byte_size             integer NOT NULL,
  is_cover              boolean NOT NULL DEFAULT false,
  sort_order            integer NOT NULL DEFAULT 0,
  state                 text NOT NULL DEFAULT 'ACTIVE',
  created_by_account_id uuid NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  revision              integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_photo_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_photo_category_fkey FOREIGN KEY (hotel_id, category_id)
    REFERENCES platform.room_category (hotel_id, category_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_photo_subject_known
    CHECK (subject_type = ANY (ARRAY['HOTEL'::text, 'ROOM_CATEGORY'::text])),
  -- A category photograph names its category; a hotel photograph names none.
  CONSTRAINT hotel_photo_subject_shape
    CHECK ((subject_type = 'ROOM_CATEGORY'::text) = (category_id IS NOT NULL)),
  CONSTRAINT hotel_photo_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'REMOVED'::text])),
  CONSTRAINT hotel_photo_cover_is_hotel
    CHECK ((NOT is_cover) OR subject_type = 'HOTEL'::text),
  CONSTRAINT hotel_photo_cover_is_active CHECK ((NOT is_cover) OR state = 'ACTIVE'::text),
  CONSTRAINT hotel_photo_key_bounded CHECK (length(object_key) BETWEEN 1 AND 400),
  CONSTRAINT hotel_photo_content_type_known
    CHECK (content_type = ANY (ARRAY['image/jpeg'::text, 'image/png'::text, 'image/webp'::text])),
  CONSTRAINT hotel_photo_size_bounded CHECK (byte_size BETWEEN 1 AND 10485760),
  CONSTRAINT hotel_photo_sort_non_negative CHECK (sort_order >= 0),
  CONSTRAINT hotel_photo_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT hotel_photo_identity_uq UNIQUE (hotel_id, photo_id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX hotel_photo_object_key_uq ON platform.hotel_photo (object_key);
--> statement-breakpoint
-- doc 09 §3.2: one cover per hotel.
CREATE UNIQUE INDEX hotel_photo_one_cover_uq
  ON platform.hotel_photo (hotel_id)
  WHERE is_cover IS TRUE;
--> statement-breakpoint
CREATE INDEX hotel_photo_subject_idx
  ON platform.hotel_photo (hotel_id, subject_type, category_id, sort_order);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.hotel_photo_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF NEW.photo_id IS DISTINCT FROM OLD.photo_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.subject_type IS DISTINCT FROM OLD.subject_type
     OR NEW.category_id IS DISTINCT FROM OLD.category_id
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.byte_size IS DISTINCT FROM OLD.byte_size
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a photograph and what it depicts are immutable; replace it instead'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.state = 'REMOVED'::text AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'a removed photograph is not restored' USING ERRCODE = '22023';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER hotel_photo_update_guard
  BEFORE UPDATE ON platform.hotel_photo
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_photo_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_photo_no_delete
  BEFORE DELETE ON platform.hotel_photo
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint

ALTER TABLE platform.hotel_photo ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_photo FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_photo
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Grants
-- =====================================================================

-- The Guest tables are account-global, like the account and session tables they
-- extend: a Guest belongs to no hotel. The API writes them; the worker reads
-- nothing here, because no job of this phase touches a person's phone.
GRANT SELECT, INSERT, UPDATE ON platform.guest_account              TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.guest_phone_verification   TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT         ON platform.guest_identity_link        TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.guest_account_link_request TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.hotel_photo                TO prsystem_api;
--> statement-breakpoint
GRANT SELECT ON platform.hotel_photo TO prsystem_worker;
--> statement-breakpoint

-- =====================================================================
-- The public listing projection
-- =====================================================================

-- doc 09 §§3 and 5: an unauthenticated searcher sees across every hotel, and
-- every tenant table is `FORCE ROW LEVEL SECURITY`. The reconciliation is the
-- one Phase 05 already uses for its pre-tenant probes: a `SECURITY DEFINER`
-- function owned by `prsystem_maintenance_fn`, a role that cannot log in, holds
-- no table of its own and reaches these rows only through the narrow policies
-- below. The API may execute the functions; it still cannot select the tables
-- across tenants.
--
-- The policies are written as the visibility rule rather than as `true`, so the
-- boundary is stated once, in the database, and a future function cannot widen
-- it by accident: an unpublished hotel is not merely unselected, it is
-- unreadable through this role.

CREATE POLICY public_listing_read ON platform.hotel_profile
  FOR SELECT TO prsystem_maintenance_fn
  USING (listing_state = 'PUBLISHED'::text);
--> statement-breakpoint
CREATE POLICY public_listing_read ON platform.hotel
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = hotel.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
CREATE POLICY public_listing_read ON platform.hotel_subscription
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = hotel_subscription.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
CREATE POLICY public_listing_read ON platform.room_category
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = room_category.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
CREATE POLICY public_listing_read ON platform.room
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = room.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
CREATE POLICY public_listing_read ON platform.hotel_photo
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = hotel_photo.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
-- A stay is read for one thing only: whether a room is occupied in a window.
-- The columns the function selects are the two times and the buffer; no
-- guest, no folio, no charge is reachable, and the policy still confines it to
-- published hotels.
CREATE POLICY public_availability_read ON platform.stay
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = stay.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint
CREATE POLICY public_availability_read ON platform.room_configuration_change
  FOR SELECT TO prsystem_maintenance_fn
  USING (EXISTS (SELECT 1 FROM platform.hotel_profile p
                  WHERE p.hotel_id = room_configuration_change.hotel_id
                    AND p.listing_state = 'PUBLISHED'::text));
--> statement-breakpoint

GRANT SELECT ON platform.hotel, platform.hotel_profile, platform.hotel_subscription,
                platform.room_category, platform.room, platform.hotel_photo,
                platform.stay, platform.room_configuration_change
  TO prsystem_maintenance_fn;
--> statement-breakpoint

-- Ownership of a `SECURITY DEFINER` function requires CREATE on the schema, and
-- the resolver role holds none between migrations. Granted for exactly these
-- two definitions and revoked below, the way every earlier phase does it.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint

-- doc 09 §5: the five conditions a hotel meets before it appears at all.
-- Account active, subscription valid, listing published, location complete,
-- public phone registered. Each is checked separately rather than through one
-- derived flag, because doc 09 §3.2 refuses to collapse them into a single
-- "active" — and the last two are held by `hotel_profile`'s own `NOT NULL`
-- columns, so the join to that table is where they are enforced.
CREATE OR REPLACE FUNCTION platform.public_hotel_listings()
  RETURNS TABLE (
    hotel_id         uuid,
    public_name      text,
    district         text,
    khoroo           text,
    address_line     text,
    public_phone     text,
    latitude_micro   integer,
    longitude_micro  integer,
    cover_object_key text,
    from_rate_mnt    bigint
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT p.hotel_id,
         p.public_name,
         p.district,
         p.khoroo,
         p.address_line,
         p.public_phone,
         p.latitude_micro,
         p.longitude_micro,
         (SELECT ph.object_key
            FROM platform.hotel_photo ph
           WHERE ph.hotel_id = p.hotel_id AND ph.is_cover AND ph.state = 'ACTIVE'
           LIMIT 1),
         -- doc 09 §3.2: `…₮-с` when no dates are chosen. The lowest published
         -- nightly rate among the categories that could be offered at all.
         (SELECT pg_catalog.min(c.nightly_rate_mnt)
            FROM platform.room_category c
           WHERE c.hotel_id = p.hotel_id
             AND c.state = 'ACTIVE'
             AND c.nightly_rate_mnt IS NOT NULL
             AND c.nightly_rate_mnt > 0)
    FROM platform.hotel_profile p
    JOIN platform.hotel h ON h.hotel_id = p.hotel_id
   -- Two of doc 09 §5's five conditions are carried by the join itself.
   -- `hotel_profile` declares its coordinates, its address and its public
   -- phone `NOT NULL`, so a hotel that has a profile has a complete location
   -- and a registered phone, and one that has neither has no profile row. A
   -- null test here would be dead SQL that read like a guarantee.
   WHERE p.listing_state = 'PUBLISHED'::text
     AND h.state = 'ACTIVE'::text
     AND EXISTS (
       SELECT 1 FROM platform.hotel_subscription s
        WHERE s.hotel_id = p.hotel_id
          AND s.suspended_at IS NULL
          AND s.starts_at <= pg_catalog.now()
          AND s.expires_at > pg_catalog.now()
     )
$$;
--> statement-breakpoint
ALTER FUNCTION platform.public_hotel_listings() OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

-- doc 09 §5: what makes a category offerable in a window.
--
-- The category is published and `ACTIVE`, its price is valid, it has a
-- photograph, and at least one `ACTIVE` physical room is free for the whole
-- window. Free means: no stay overlaps it, where a stay occupies
-- `[check-in, checkout + its own snapshotted cleaning buffer)` — the buffer
-- the stay captured, never the configuration's current value — and the room
-- carries no non-terminal minibar configuration change.
--
-- Intervals are half-open, so one stay's end meeting another's start is not an
-- overlap (`STAY-DEC-008`).
CREATE OR REPLACE FUNCTION platform.public_category_offers(
  p_hotel_id uuid,
  p_start    timestamptz,
  p_end      timestamptz
) RETURNS TABLE (
    category_id      uuid,
    name             text,
    description      text,
    nightly_rate_mnt bigint,
    available_rooms  bigint,
    photo_object_key text
  )
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT c.category_id,
         c.name,
         c.description,
         c.nightly_rate_mnt,
         (SELECT pg_catalog.count(*)
            FROM platform.room r
           WHERE r.hotel_id = c.hotel_id
             AND r.category_id = c.category_id
             AND r.state = 'ACTIVE'::text
             AND NOT EXISTS (
               SELECT 1 FROM platform.stay s
                WHERE s.room_id = r.room_id
                  AND s.state = ANY (ARRAY['ACTIVE'::text, 'CHECKOUT_IN_PROGRESS'::text,
                                           'COMPLETED'::text])
                  AND coalesce(s.actual_check_in_at, s.created_at) < p_end
                  AND coalesce(s.actual_checkout_at, s.planned_checkout_at)
                      + pg_catalog.make_interval(mins => s.cleaning_buffer_minutes) > p_start
             )
             AND NOT EXISTS (
               SELECT 1 FROM platform.room_configuration_change rc
                WHERE rc.room_id = r.room_id
                  AND rc.state <> ALL (ARRAY['APPLIED'::text, 'CANCELLED'::text,
                                             'ROLLED_BACK'::text])
             )),
         (SELECT ph.object_key
            FROM platform.hotel_photo ph
           WHERE ph.hotel_id = c.hotel_id
             AND ph.category_id = c.category_id
             AND ph.state = 'ACTIVE'
           ORDER BY ph.sort_order, ph.created_at
           LIMIT 1)
    FROM platform.room_category c
   WHERE c.hotel_id = p_hotel_id
     AND c.state = 'ACTIVE'::text
     AND c.nightly_rate_mnt IS NOT NULL
     AND c.nightly_rate_mnt > 0
     AND EXISTS (
       SELECT 1 FROM platform.hotel_photo ph
        WHERE ph.hotel_id = c.hotel_id AND ph.category_id = c.category_id
          AND ph.state = 'ACTIVE'
     )
     AND EXISTS (
       SELECT 1 FROM platform.hotel_profile p
        WHERE p.hotel_id = c.hotel_id AND p.listing_state = 'PUBLISHED'::text
     )
$$;
--> statement-breakpoint
ALTER FUNCTION platform.public_category_offers(uuid, timestamptz, timestamptz)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

REVOKE ALL ON FUNCTION
  platform.public_hotel_listings(),
  platform.public_category_offers(uuid, timestamptz, timestamptz)
  FROM PUBLIC;
--> statement-breakpoint
-- The API alone. The worker has no public surface, and neither role can read
-- the underlying rows across tenants without going through these bodies.
GRANT EXECUTE ON FUNCTION
  platform.public_hotel_listings(),
  platform.public_category_offers(uuid, timestamptz, timestamptz)
  TO prsystem_api;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
