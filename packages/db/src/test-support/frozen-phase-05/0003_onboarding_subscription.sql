-- Hotel onboarding, subscription pricing, payment and lifecycle.
--
-- Adds the pre-tenant onboarding graph (application, owner, phone verification,
-- ownership proof, payment attempt, append-only application history), the
-- tenant-scoped subscription graph (profile, owner link, subscription, billing
-- intent, confirmed payment, append-only lifecycle history, eBarimt issuance),
-- the first Hotel Admin's activation axis with its durable sealed delivery, and
-- the minimum cash-location root the default `Үндсэн касс` drawer needs.
--
-- Two structural rules run through all of it.
--
-- **Nothing is provisioned without payment.** No runtime role holds INSERT on
-- `platform.hotel`, and this migration does not grant one. A tenant comes into
-- existence only through `platform.provision_paid_hotel`, which re-derives the
-- payment, the state and the owner link from the database inside the caller's
-- transaction and refuses everything else. An unpaid caller cannot reach it.
--
-- **A pre-tenant row belongs to nobody's hotel.** The application graph carries
-- no `hotel_id`, no nullable tenant column and no platform sentinel. Its
-- isolation is `app.onboarding_ref`, a transaction-local reference the API
-- establishes only after the applicant has presented the bearer secret their
-- own draft was minted with — plus an explicit Operation-realm review policy.
-- Unset, the reference is NULL and every policy matches zero rows.
--
-- docs 15 (`ONB-DEC-001`…`008`), 16 (`SUB-DEC-001`…`009`),
-- 17 (`LIFE-DEC-001`…`007`), 14 (`OPS-DEC-006`, `OPS-DEC-007`), 24 §2.1;
-- ADR-0007 (money), ADR-0009 (append-only), ADR-0010 (outbox), ADR-0011
-- (revision/CAS), ADR-0017 (RLS + roles), ADR-0018 (audit), ADR-0020 (keys),
-- ADR-0004 (versioned SQL).

SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
SET LOCAL statement_timeout = '120s';
--> statement-breakpoint

-- The kernel revoked CREATE on `platform` from the narrow definer owners once
-- its own ownership was settled, and said in as many words that the next
-- migration re-grants it if it has to transfer ownership again. This one does:
-- the provisioning wrapper below belongs to `prsystem_maintenance_fn`. The
-- privilege is revoked again at the end of this file.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint

-- ------------------------------------------------ the pre-tenant scope
-- The isolation unit for work that has no tenant yet.
--
-- It is deliberately *not* `app.hotel_id`. An application exists before any
-- hotel does, so a tenant column would have to be nullable or carry the platform
-- sentinel — and both turn "no tenant" into a value every other applicant also
-- holds. This is one reference, established from a bearer secret the applicant
-- presented, and NULL for everybody else.
CREATE OR REPLACE FUNCTION platform.current_onboarding_ref() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.onboarding_ref', true), '')::uuid $$;
--> statement-breakpoint

-- `LIFE-DEC-001`: the package lattice, as a total order.
--
-- Upgrade-only is an ordering rule, so the ordering is a database function and
-- the CHECK constraints below state the rule directly. A service-side comparison
-- would leave a direct statement free to write a downgrade.
CREATE OR REPLACE FUNCTION platform.package_rank(p_package text) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
  SELECT CASE p_package
           WHEN 'P20' THEN 1
           WHEN 'P25' THEN 2
           WHEN 'P30' THEN 3
         END
$$;
--> statement-breakpoint

-- =====================================================================
-- Pre-tenant onboarding
-- =====================================================================

-- doc 15 §2.3 / `ONB-DEC-005`: one citizen or organisation may own several
-- hotels, and the profile is reused rather than duplicated. The identifier is
-- envelope-encrypted; exact lookup goes through a versioned, type- and
-- country-namespaced keyed HMAC (ADR-0020 §6), never the plaintext and never an
-- unkeyed digest.
CREATE TABLE platform.subscription_owner (
  owner_id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type                     text NOT NULL,
  display_name                   text NOT NULL,
  representative_name            text,
  representative_position        text,
  identity_type                  text NOT NULL,
  country_code                   text NOT NULL DEFAULT 'MN',
  identifier_ciphertext          bytea NOT NULL,
  identifier_wrapped_dek         bytea NOT NULL,
  identifier_key_version         text NOT NULL,
  identifier_lookup_token        text NOT NULL,
  identifier_lookup_key_version  text NOT NULL,
  -- doc 15 §3.1: the owner's *previously stored, verified* channels. A new
  -- application never overwrites them and never counts as proof of them.
  verified_email_normalized      text,
  verified_phone                 text,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  revision                       integer NOT NULL DEFAULT 0,
  CONSTRAINT subscription_owner_country_shape CHECK (country_code ~ '^[A-Z]{2}$'::text),
  CONSTRAINT subscription_owner_display_name_bounded
    CHECK (length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT subscription_owner_email_normalised
    CHECK ((verified_email_normalized IS NULL)
           OR (verified_email_normalized = lower(verified_email_normalized))),
  CONSTRAINT subscription_owner_identity_type_known
    CHECK (identity_type = ANY (ARRAY['registration_number'::text])),
  CONSTRAINT subscription_owner_lookup_shape
    CHECK (identifier_lookup_token ~ '^[0-9a-f]{64}$'::text),
  -- doc 15 §2.2: an organisation owns through a named authorised representative.
  -- A citizen has none. Neither shape can be written as the other.
  CONSTRAINT subscription_owner_representative_matches_type
    CHECK (CASE owner_type
             WHEN 'ORGANIZATION'::text THEN
               representative_name IS NOT NULL AND representative_position IS NOT NULL
             ELSE representative_name IS NULL AND representative_position IS NULL
           END),
  CONSTRAINT subscription_owner_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT subscription_owner_type_known
    CHECK (owner_type = ANY (ARRAY['CITIZEN'::text, 'ORGANIZATION'::text])),
  -- `ONB-DEC-005`: one registration number, one owner profile.
  CONSTRAINT subscription_owner_identifier_uq
    UNIQUE (identity_type, country_code, identifier_lookup_token)
);
--> statement-breakpoint

-- doc 15 §3 and §7. The only thing that exists before payment.
--
-- The commercial figures are a snapshot taken when the invoice was quoted, in
-- integer MNT (ADR-0007). They are never re-derived from current configuration
-- later, which is what keeps a price change from rewriting a paid subscription.
CREATE TABLE platform.onboarding_application (
  application_id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state                             text NOT NULL DEFAULT 'DRAFT',
  owner_type                        text NOT NULL,
  -- The bearer reference an anonymous applicant returns with. Stored as a
  -- versioned keyed digest, exactly like every other one-time secret: a database
  -- reader cannot mint one (`STAFF-DEC-001`, ADR-0020 §6).
  applicant_token_hash              text NOT NULL,
  applicant_token_key_version       text NOT NULL,

  -- ---- owner input (doc 15 §2.1, §2.2)
  owner_display_name                text NOT NULL,
  representative_name               text,
  representative_position           text,
  owner_identity_type               text NOT NULL DEFAULT 'registration_number',
  owner_country_code                text NOT NULL DEFAULT 'MN',
  owner_identifier_ciphertext       bytea NOT NULL,
  owner_identifier_wrapped_dek      bytea NOT NULL,
  owner_identifier_key_version      text NOT NULL,
  owner_identifier_lookup_token     text NOT NULL,
  owner_identifier_lookup_key_version text NOT NULL,

  -- ---- contact (doc 15 §2.1)
  contact_phone                     text NOT NULL,
  contact_phone_verified_at         timestamptz,
  subscription_contact_phone        text NOT NULL,
  admin_email_normalized            text NOT NULL,

  -- ---- hotel (doc 15 §2.1; the coordinate is server-stored, §2.1 last row)
  hotel_display_name                text NOT NULL,
  hotel_public_phone                text NOT NULL,
  district                          text NOT NULL,
  khoroo                            text NOT NULL,
  address_line                      text NOT NULL,
  -- Integer micro-degrees, not floating point (CLAUDE.md §5). 1e-6° is about
  -- 0.11 m, far finer than a hotel entrance needs, and it round-trips exactly.
  latitude_micro                    integer NOT NULL,
  longitude_micro                   integer NOT NULL,

  -- ---- commercial snapshot (doc 16 §4)
  package_code                      text NOT NULL,
  term_months                       integer NOT NULL,
  monthly_price_mnt                 bigint NOT NULL,
  discount_mnt                      bigint NOT NULL DEFAULT 0,
  total_amount_mnt                  bigint NOT NULL,
  currency                          text NOT NULL DEFAULT 'MNT',
  vat_inclusive                     boolean NOT NULL DEFAULT true,
  vat_rate_bp                       integer NOT NULL,
  price_book_version                text NOT NULL,
  tax_config_version                text NOT NULL,
  package_feature_version           text NOT NULL,

  -- ---- resolution
  existing_account_id               uuid,
  owner_id                          uuid,
  duplicate_review_required         boolean NOT NULL DEFAULT false,
  provisioned_hotel_id              uuid,
  paid_attempt_id                   uuid,
  payment_confirmed_at              timestamptz,
  provision_attempts                integer NOT NULL DEFAULT 0,
  revision                          integer NOT NULL DEFAULT 0,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  state_changed_at                  timestamptz,
  state_reason                      text,

  CONSTRAINT onboarding_application_existing_account_fkey FOREIGN KEY (existing_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_application_owner_fkey FOREIGN KEY (owner_id)
    REFERENCES platform.subscription_owner (owner_id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_application_hotel_fkey FOREIGN KEY (provisioned_hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,

  CONSTRAINT onboarding_application_address_bounded
    CHECK (length(address_line) BETWEEN 1 AND 300),
  CONSTRAINT onboarding_application_country_shape CHECK (owner_country_code ~ '^[A-Z]{2}$'::text),
  CONSTRAINT onboarding_application_currency_known CHECK (currency = 'MNT'::text),
  -- `SUB-DEC-003`: there is no MVP discount, so a non-zero one is unrepresentable.
  CONSTRAINT onboarding_application_discount_zero CHECK (discount_mnt = 0),
  CONSTRAINT onboarding_application_email_normalised
    CHECK (admin_email_normalized = lower(admin_email_normalized)),
  CONSTRAINT onboarding_application_email_shape
    CHECK (admin_email_normalized ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'::text),
  CONSTRAINT onboarding_application_identity_type_known
    CHECK (owner_identity_type = ANY (ARRAY['registration_number'::text])),
  CONSTRAINT onboarding_application_latitude_range
    CHECK (latitude_micro BETWEEN -90000000 AND 90000000),
  CONSTRAINT onboarding_application_longitude_range
    CHECK (longitude_micro BETWEEN -180000000 AND 180000000),
  CONSTRAINT onboarding_application_lookup_shape
    CHECK (owner_identifier_lookup_token ~ '^[0-9a-f]{64}$'::text),
  -- `SUB-DEC-001` / `SUB-DEC-002`: the three monthly prices, the four terms, and
  -- a total that is exactly their product. A tampered client total cannot be
  -- stored even if a service forgot to recompute it.
  CONSTRAINT onboarding_application_package_known
    CHECK (package_code = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text])),
  CONSTRAINT onboarding_application_monthly_price_matches_package
    CHECK (monthly_price_mnt = CASE package_code
                                 WHEN 'P20'::text THEN 20000
                                 WHEN 'P25'::text THEN 25000
                                 WHEN 'P30'::text THEN 30000
                               END),
  CONSTRAINT onboarding_application_term_known
    CHECK (term_months = ANY (ARRAY[1, 3, 7, 12])),
  CONSTRAINT onboarding_application_total_is_product
    CHECK (total_amount_mnt = (monthly_price_mnt * term_months) - discount_mnt),
  CONSTRAINT onboarding_application_provision_attempts_non_negative
    CHECK (provision_attempts >= 0),
  CONSTRAINT onboarding_application_representative_matches_type
    CHECK (CASE owner_type
             WHEN 'ORGANIZATION'::text THEN
               representative_name IS NOT NULL AND representative_position IS NOT NULL
             ELSE representative_name IS NULL AND representative_position IS NULL
           END),
  CONSTRAINT onboarding_application_revision_non_negative CHECK (revision >= 0),
  -- doc 15 §7: the canonical state list, and nothing else.
  CONSTRAINT onboarding_application_state_known
    CHECK (state = ANY (ARRAY['DRAFT'::text, 'OWNER_VERIFICATION_REQUIRED'::text,
                              'PENDING_PAYMENT'::text, 'PAYMENT_UNCERTAIN'::text,
                              'PAYMENT_FAILED'::text, 'PAYMENT_EXPIRED'::text,
                              'PAID_OWNER_VERIFICATION_REQUIRED'::text,
                              'PAID_PENDING_PROVISIONING'::text, 'PROVISIONING'::text,
                              'PROVISIONING_FAILED'::text, 'PROVISIONED'::text])),
  -- `ONB-DEC-001`: a hotel exists only under a paid state, and a paid state
  -- always carries the payment that made it so.
  CONSTRAINT onboarding_application_paid_states_have_payment
    CHECK ((state = ANY (ARRAY['PAID_OWNER_VERIFICATION_REQUIRED'::text,
                               'PAID_PENDING_PROVISIONING'::text, 'PROVISIONING'::text,
                               'PROVISIONING_FAILED'::text, 'PROVISIONED'::text]))
           = (paid_attempt_id IS NOT NULL)),
  CONSTRAINT onboarding_application_payment_time_matches_attempt
    CHECK ((paid_attempt_id IS NULL) = (payment_confirmed_at IS NULL)),
  CONSTRAINT onboarding_application_provisioned_has_hotel
    CHECK ((state = 'PROVISIONED'::text) = (provisioned_hotel_id IS NOT NULL)),
  CONSTRAINT onboarding_application_token_shape
    CHECK (applicant_token_hash ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT onboarding_application_type_known
    CHECK (owner_type = ANY (ARRAY['CITIZEN'::text, 'ORGANIZATION'::text])),
  CONSTRAINT onboarding_application_vat_rate_range CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  CONSTRAINT onboarding_application_token_uq UNIQUE (applicant_token_hash)
);
--> statement-breakpoint

-- One application per provisioned hotel (doc 15 §5, provisioning protections).
CREATE UNIQUE INDEX onboarding_application_hotel_uq
  ON platform.onboarding_application (provisioned_hotel_id)
  WHERE provisioned_hotel_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX onboarding_application_owner_lookup_idx
  ON platform.onboarding_application (owner_identifier_lookup_token);
--> statement-breakpoint
CREATE INDEX onboarding_application_state_idx
  ON platform.onboarding_application (state, created_at);
--> statement-breakpoint

-- doc 15 §2.1: the citizen's or representative's phone is OTP-verified.
--
-- The code is a versioned keyed digest bound to its purpose and subject, never
-- plaintext (CLAUDE.md §8). Attempts are counted in the row so a guess budget is
-- a database fact rather than a service convention.
CREATE TABLE platform.onboarding_phone_verification (
  verification_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id    uuid NOT NULL,
  purpose           text NOT NULL DEFAULT 'owner_phone',
  phone             text NOT NULL,
  code_digest       text,
  code_key_version  text,
  state             text NOT NULL DEFAULT 'PENDING',
  attempts          integer NOT NULL DEFAULT 0,
  max_attempts      integer NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  expires_at        timestamptz NOT NULL,
  settled_at        timestamptz,
  CONSTRAINT onboarding_phone_verification_application_fkey FOREIGN KEY (application_id)
    REFERENCES platform.onboarding_application (application_id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_phone_verification_attempts_bounded
    CHECK (attempts >= 0 AND attempts <= max_attempts),
  CONSTRAINT onboarding_phone_verification_code_complete
    CHECK (num_nonnulls(code_digest, code_key_version) = ANY (ARRAY[0, 2])),
  -- A settled challenge holds no usable code: a verified or dead challenge that
  -- kept its digest would still be redeemable evidence.
  CONSTRAINT onboarding_phone_verification_settled_holds_no_code
    CHECK ((code_digest IS NULL) OR (state = 'PENDING'::text)),
  CONSTRAINT onboarding_phone_verification_digest_shape
    CHECK ((code_digest IS NULL) OR (code_digest ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT onboarding_phone_verification_expiry_after_creation
    CHECK (expires_at > created_at),
  CONSTRAINT onboarding_phone_verification_max_attempts_positive CHECK (max_attempts >= 1),
  CONSTRAINT onboarding_phone_verification_purpose_known
    CHECK (purpose = ANY (ARRAY['owner_phone'::text])),
  CONSTRAINT onboarding_phone_verification_settled_has_time
    CHECK ((state = 'PENDING'::text) = (settled_at IS NULL)),
  CONSTRAINT onboarding_phone_verification_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'VERIFIED'::text, 'EXPIRED'::text,
                              'FAILED'::text]))
);
--> statement-breakpoint

CREATE UNIQUE INDEX onboarding_phone_verification_pending_uq
  ON platform.onboarding_phone_verification (application_id, purpose)
  WHERE state = 'PENDING'::text;
--> statement-breakpoint

-- doc 15 §3.1 / `ONB-DEC-007`: an existing owner is never attached on the
-- strength of the contact details the new application supplied. One of three
-- proofs must pass, and the destination is only ever recorded masked.
CREATE TABLE platform.onboarding_owner_proof (
  proof_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id       uuid NOT NULL,
  owner_id             uuid NOT NULL,
  method               text NOT NULL,
  state                text NOT NULL DEFAULT 'PENDING',
  challenge_digest     text,
  challenge_key_version text,
  masked_destination   text,
  decided_by_account_id uuid,
  decision_reason      text,
  attempts             integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  expires_at           timestamptz NOT NULL,
  decided_at           timestamptz,
  CONSTRAINT onboarding_owner_proof_application_fkey FOREIGN KEY (application_id)
    REFERENCES platform.onboarding_application (application_id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_owner_proof_owner_fkey FOREIGN KEY (owner_id)
    REFERENCES platform.subscription_owner (owner_id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_owner_proof_decided_by_fkey FOREIGN KEY (decided_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_owner_proof_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT onboarding_owner_proof_challenge_complete
    CHECK (num_nonnulls(challenge_digest, challenge_key_version) = ANY (ARRAY[0, 2])),
  CONSTRAINT onboarding_owner_proof_settled_holds_no_challenge
    CHECK ((challenge_digest IS NULL) OR (state = 'PENDING'::text)),
  CONSTRAINT onboarding_owner_proof_digest_shape
    CHECK ((challenge_digest IS NULL) OR (challenge_digest ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT onboarding_owner_proof_decided_has_time
    CHECK ((state = 'PENDING'::text) = (decided_at IS NULL)),
  CONSTRAINT onboarding_owner_proof_expiry_after_creation CHECK (expires_at > created_at),
  -- doc 15 §3.1: an offline verification is a Platform Super Admin's audited
  -- decision, so it names the account that made it. The other two methods are
  -- proved by the challenger, not decided by an operator.
  CONSTRAINT onboarding_owner_proof_method_known
    CHECK (method = ANY (ARRAY['AUTHENTICATED_ACCOUNT'::text,
                               'STORED_CONTACT_CHALLENGE'::text,
                               'OFFLINE_VERIFICATION'::text])),
  CONSTRAINT onboarding_owner_proof_offline_has_decider
    CHECK ((method <> 'OFFLINE_VERIFICATION'::text) OR (state = 'PENDING'::text)
           OR (decided_by_account_id IS NOT NULL)),
  CONSTRAINT onboarding_owner_proof_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'PASSED'::text, 'FAILED'::text,
                              'EXPIRED'::text]))
);
--> statement-breakpoint

CREATE UNIQUE INDEX onboarding_owner_proof_pending_uq
  ON platform.onboarding_owner_proof (application_id)
  WHERE state = 'PENDING'::text;
--> statement-breakpoint
CREATE UNIQUE INDEX onboarding_owner_proof_passed_uq
  ON platform.onboarding_owner_proof (application_id)
  WHERE state = 'PASSED'::text;
--> statement-breakpoint

-- doc 15 §4.1 / `ONB-DEC-008`. One active attempt per application; every
-- terminal attempt is immutable history; the price snapshot is the attempt's
-- own, so a later price change cannot restate what was invoiced.
CREATE TABLE platform.onboarding_payment_attempt (
  attempt_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id          uuid NOT NULL,
  provider                text NOT NULL,
  merchant_ref            text NOT NULL,
  provider_invoice_id     text NOT NULL,
  provider_payment_id     text,
  state                   text NOT NULL DEFAULT 'PENDING',
  amount_mnt              bigint NOT NULL,
  currency                text NOT NULL DEFAULT 'MNT',
  package_code            text NOT NULL,
  term_months             integer NOT NULL,
  monthly_price_mnt       bigint NOT NULL,
  discount_mnt            bigint NOT NULL DEFAULT 0,
  vat_rate_bp             integer NOT NULL,
  price_book_version      text NOT NULL,
  tax_config_version      text NOT NULL,
  package_feature_version text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  expires_at              timestamptz NOT NULL,
  confirmed_at            timestamptz,
  terminal_at             timestamptz,
  terminal_reason         text,
  -- doc 15 §4.1 / `LIFE-DEC-007`: a second or late capture is not an
  -- entitlement. It becomes a case somebody has to close with evidence.
  reconciliation_outcome  text,
  reconciled_by_account_id uuid,
  reconciled_at           timestamptz,
  reconciliation_reason   text,
  revision                integer NOT NULL DEFAULT 0,
  CONSTRAINT onboarding_payment_attempt_application_fkey FOREIGN KEY (application_id)
    REFERENCES platform.onboarding_application (application_id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_payment_attempt_reconciled_by_fkey FOREIGN KEY (reconciled_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_payment_attempt_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT onboarding_payment_attempt_amount_is_product
    CHECK (amount_mnt = (monthly_price_mnt * term_months) - discount_mnt),
  CONSTRAINT onboarding_payment_attempt_confirmed_has_provider_payment
    CHECK ((confirmed_at IS NULL) = (provider_payment_id IS NULL)),
  CONSTRAINT onboarding_payment_attempt_currency_known CHECK (currency = 'MNT'::text),
  CONSTRAINT onboarding_payment_attempt_discount_zero CHECK (discount_mnt = 0),
  CONSTRAINT onboarding_payment_attempt_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT onboarding_payment_attempt_package_known
    CHECK (package_code = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text])),
  CONSTRAINT onboarding_payment_attempt_paid_has_confirmation
    CHECK ((state = ANY (ARRAY['PAID'::text, 'PAID_REQUIRES_RECONCILIATION'::text]))
           <= (confirmed_at IS NOT NULL)),
  -- `SUB-DEC-004`: one provider-neutral model, two providers.
  CONSTRAINT onboarding_payment_attempt_provider_known
    CHECK (provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text])),
  CONSTRAINT onboarding_payment_attempt_reconciled_complete
    CHECK (num_nonnulls(reconciliation_outcome, reconciled_by_account_id, reconciled_at)
           = ANY (ARRAY[0, 3])),
  CONSTRAINT onboarding_payment_attempt_reconciliation_outcome_known
    CHECK ((reconciliation_outcome IS NULL)
           OR (reconciliation_outcome = ANY (ARRAY['PROVIDER_CORRECTED_NOT_PAID'::text,
                                                   'EXTERNALLY_VOIDED'::text,
                                                   'FINANCE_CLOSED_EXCEPTION'::text]))),
  CONSTRAINT onboarding_payment_attempt_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT onboarding_payment_attempt_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'PAYMENT_UNCERTAIN'::text, 'PAID'::text,
                              'FAILED'::text, 'EXPIRED'::text, 'CANCELLED'::text,
                              'PAID_REQUIRES_RECONCILIATION'::text])),
  CONSTRAINT onboarding_payment_attempt_term_known
    CHECK (term_months = ANY (ARRAY[1, 3, 7, 12])),
  CONSTRAINT onboarding_payment_attempt_terminal_has_time
    CHECK ((state = ANY (ARRAY['PENDING'::text, 'PAYMENT_UNCERTAIN'::text]))
           = (terminal_at IS NULL)),
  CONSTRAINT onboarding_payment_attempt_vat_rate_range CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  -- doc 15 §4.1: a provider payment id is unique inside its provider's scope.
  CONSTRAINT onboarding_payment_attempt_invoice_uq UNIQUE (provider, provider_invoice_id)
);
--> statement-breakpoint

-- One non-terminal attempt per application: `PAYMENT_UNCERTAIN` blocks a
-- replacement invoice exactly as `ONB-DEC-008` requires, and it is the index
-- that refuses the second one, not the service.
CREATE UNIQUE INDEX onboarding_payment_attempt_active_uq
  ON platform.onboarding_payment_attempt (application_id)
  WHERE state = ANY (ARRAY['PENDING'::text, 'PAYMENT_UNCERTAIN'::text]);
--> statement-breakpoint
CREATE UNIQUE INDEX onboarding_payment_attempt_provider_payment_uq
  ON platform.onboarding_payment_attempt (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX onboarding_payment_attempt_application_idx
  ON platform.onboarding_payment_attempt (application_id, created_at);
--> statement-breakpoint
CREATE INDEX onboarding_payment_attempt_reconciliation_idx
  ON platform.onboarding_payment_attempt (state, confirmed_at)
  WHERE state = 'PAID_REQUIRES_RECONCILIATION'::text;
--> statement-breakpoint

-- doc 15 §8: the application's canonical before/after state, append-only.
CREATE TABLE platform.onboarding_event (
  event_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id uuid NOT NULL,
  from_state     text,
  to_state       text NOT NULL,
  reason         text,
  actor_ref      text NOT NULL,
  correlation_id text,
  detail         jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_event_application_fkey FOREIGN KEY (application_id)
    REFERENCES platform.onboarding_application (application_id) ON DELETE RESTRICT,
  CONSTRAINT onboarding_event_detail_sanitised
    CHECK (NOT platform.contains_denied_key(detail))
);
--> statement-breakpoint

CREATE INDEX onboarding_event_application_idx
  ON platform.onboarding_event (application_id, event_id);
--> statement-breakpoint

-- =====================================================================
-- Tenant-scoped subscription graph
-- =====================================================================

-- doc 15 §2.1: the submitted district, khoroo, address and coordinate, persisted
-- and validated. No geocoding, no distance and no public discovery: `GeoPort`,
-- Google Maps and the public portal are Phase 12, and EXT-06 is blocked.
CREATE TABLE platform.hotel_profile (
  hotel_id                  uuid PRIMARY KEY,
  public_name               text NOT NULL,
  public_phone              text NOT NULL,
  district                  text NOT NULL,
  khoroo                    text NOT NULL,
  address_line              text NOT NULL,
  latitude_micro            integer NOT NULL,
  longitude_micro           integer NOT NULL,
  -- doc 15 §5.1: a suspicious duplicate does not cancel a paid provisioning; it
  -- blocks publication until somebody has looked.
  duplicate_review_required boolean NOT NULL DEFAULT false,
  listing_state             text NOT NULL DEFAULT 'UNLISTED',
  created_at                timestamptz NOT NULL DEFAULT now(),
  revision                  integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_profile_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_profile_address_bounded CHECK (length(address_line) BETWEEN 1 AND 300),
  CONSTRAINT hotel_profile_latitude_range
    CHECK (latitude_micro BETWEEN -90000000 AND 90000000),
  CONSTRAINT hotel_profile_longitude_range
    CHECK (longitude_micro BETWEEN -180000000 AND 180000000),
  -- doc 15 §5.1 and §6: publication is a separate axis, and a hotel under
  -- duplicate review may not carry it.
  CONSTRAINT hotel_profile_listing_state_known
    CHECK (listing_state = ANY (ARRAY['UNLISTED'::text, 'PUBLISHED'::text])),
  CONSTRAINT hotel_profile_review_blocks_listing
    CHECK ((NOT duplicate_review_required) OR (listing_state = 'UNLISTED'::text)),
  CONSTRAINT hotel_profile_revision_non_negative CHECK (revision >= 0)
);
--> statement-breakpoint

-- doc 15 §2.3: one owner, many hotels; one hotel, one owner, one application.
CREATE TABLE platform.hotel_owner_link (
  hotel_id       uuid PRIMARY KEY,
  owner_id       uuid NOT NULL,
  owner_type     text NOT NULL,
  application_id uuid NOT NULL,
  linked_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hotel_owner_link_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_owner_link_owner_fkey FOREIGN KEY (owner_id)
    REFERENCES platform.subscription_owner (owner_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_owner_link_application_fkey FOREIGN KEY (application_id)
    REFERENCES platform.onboarding_application (application_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_owner_link_type_known
    CHECK (owner_type = ANY (ARRAY['CITIZEN'::text, 'ORGANIZATION'::text])),
  CONSTRAINT hotel_owner_link_application_uq UNIQUE (application_id)
);
--> statement-breakpoint

-- The authoritative subscription row. Authorization stage 5 reads this and
-- nothing derived from it (ADR-0019 §4, `OPS-DEC-016`).
--
-- `OPS-DEC-006`: `starts_at` is the confirmed payment instant and `expires_at`
-- is that instant plus the chosen calendar months in `Asia/Ulaanbaatar`, with
-- end-of-month clamping.
--
-- There is deliberately no `grace_expires_at` column. `LIFE-DEC-003` fixes grace
-- at exactly 48 hours past expiry, so it is derived — `expires_at + 48 hours` —
-- rather than stored. A stored copy would be a second place the boundary lives,
-- and the only thing a writer could do with it is disagree with the rule.
CREATE TABLE platform.hotel_subscription (
  subscription_id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                    uuid NOT NULL,
  effective_package           text NOT NULL,
  package_floor               text NOT NULL,
  pending_upgrade_package     text,
  pending_upgrade_effective_at timestamptz,
  term_months                 integer NOT NULL,
  timezone                    text NOT NULL DEFAULT 'Asia/Ulaanbaatar',
  starts_at                   timestamptz NOT NULL,
  expires_at                  timestamptz NOT NULL,
  suspended_at                timestamptz,
  suspension_reason           text,
  billing_revision            integer NOT NULL DEFAULT 1,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  revision                    integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_subscription_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_subscription_billing_revision_positive CHECK (billing_revision >= 1),
  CONSTRAINT hotel_subscription_expiry_after_start CHECK (expires_at > starts_at),
  -- `LIFE-DEC-001`: the floor never sits below the package actually in force,
  -- and a paid pending target never sits at or below the floor.
  CONSTRAINT hotel_subscription_floor_not_below_effective
    CHECK (platform.package_rank(package_floor)
           >= platform.package_rank(effective_package)),
  CONSTRAINT hotel_subscription_package_known
    CHECK (effective_package = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text])),
  CONSTRAINT hotel_subscription_floor_known
    CHECK (package_floor = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text])),
  CONSTRAINT hotel_subscription_pending_complete
    CHECK (num_nonnulls(pending_upgrade_package, pending_upgrade_effective_at)
           = ANY (ARRAY[0, 2])),
  CONSTRAINT hotel_subscription_pending_is_an_upgrade
    CHECK ((pending_upgrade_package IS NULL)
           OR (platform.package_rank(pending_upgrade_package)
               > platform.package_rank(effective_package))),
  CONSTRAINT hotel_subscription_pending_within_floor
    CHECK ((pending_upgrade_package IS NULL)
           OR (platform.package_rank(package_floor)
               >= platform.package_rank(pending_upgrade_package))),
  CONSTRAINT hotel_subscription_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT hotel_subscription_suspension_complete
    CHECK ((suspended_at IS NULL) = (suspension_reason IS NULL)),
  CONSTRAINT hotel_subscription_term_known CHECK (term_months = ANY (ARRAY[1, 3, 7, 12])),
  CONSTRAINT hotel_subscription_timezone_known CHECK (timezone = 'Asia/Ulaanbaatar'::text),
  -- doc 15 §5: one hotel, one initial subscription. Renewals extend this row.
  CONSTRAINT hotel_subscription_hotel_uq UNIQUE (hotel_id),
  CONSTRAINT hotel_subscription_scope_uq UNIQUE (hotel_id, subscription_id)
);
--> statement-breakpoint

CREATE INDEX hotel_subscription_boundary_idx
  ON platform.hotel_subscription (pending_upgrade_effective_at)
  WHERE pending_upgrade_package IS NOT NULL;
--> statement-breakpoint

-- doc 17 §4.4 / `LIFE-DEC-006`: one unpaid, non-terminal billing intent per
-- subscription, and every quote carries the billing revision and the expiry it
-- was computed against so a later commit can tell that it went stale.
CREATE TABLE platform.subscription_billing_intent (
  intent_id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                 uuid NOT NULL,
  subscription_id          uuid NOT NULL,
  kind                     text NOT NULL,
  state                    text NOT NULL DEFAULT 'PENDING',
  provider                 text NOT NULL,
  merchant_ref             text NOT NULL,
  provider_invoice_id      text NOT NULL,
  provider_payment_id      text,
  amount_mnt               bigint NOT NULL,
  currency                 text NOT NULL DEFAULT 'MNT',
  discount_mnt             bigint NOT NULL DEFAULT 0,
  quoted_billing_revision  integer NOT NULL,
  current_package          text NOT NULL,
  target_package           text NOT NULL,
  term_months              integer,
  monthly_price_mnt        bigint NOT NULL,
  price_delta_mnt          bigint,
  remaining_service_months integer,
  effective_at             timestamptz,
  quoted_expires_at        timestamptz NOT NULL,
  vat_rate_bp              integer NOT NULL,
  price_book_version       text NOT NULL,
  tax_config_version       text NOT NULL,
  package_feature_version  text NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  confirmed_at             timestamptz,
  terminal_at              timestamptz,
  terminal_reason          text,
  reconciliation_outcome   text,
  reconciled_by_account_id uuid,
  reconciled_at            timestamptz,
  reconciliation_reason    text,
  revision                 integer NOT NULL DEFAULT 0,
  CONSTRAINT subscription_billing_intent_subscription_fkey FOREIGN KEY (hotel_id, subscription_id)
    REFERENCES platform.hotel_subscription (hotel_id, subscription_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_billing_intent_reconciled_by_fkey FOREIGN KEY (reconciled_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_billing_intent_amount_positive CHECK (amount_mnt > 0),
  CONSTRAINT subscription_billing_intent_confirmed_has_provider_payment
    CHECK ((confirmed_at IS NULL) = (provider_payment_id IS NULL)),
  CONSTRAINT subscription_billing_intent_currency_known CHECK (currency = 'MNT'::text),
  CONSTRAINT subscription_billing_intent_discount_zero CHECK (discount_mnt = 0),
  CONSTRAINT subscription_billing_intent_expiry_after_creation CHECK (expires_at > created_at),
  CONSTRAINT subscription_billing_intent_kind_known
    CHECK (kind = ANY (ARRAY['RENEWAL'::text, 'UPGRADE'::text])),
  CONSTRAINT subscription_billing_intent_package_known
    CHECK (current_package = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text])
           AND target_package = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text])),
  CONSTRAINT subscription_billing_intent_provider_known
    CHECK (provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text])),
  CONSTRAINT subscription_billing_intent_quoted_revision_positive
    CHECK (quoted_billing_revision >= 1),
  CONSTRAINT subscription_billing_intent_reconciled_complete
    CHECK (num_nonnulls(reconciliation_outcome, reconciled_by_account_id, reconciled_at)
           = ANY (ARRAY[0, 3])),
  CONSTRAINT subscription_billing_intent_reconciliation_outcome_known
    CHECK ((reconciliation_outcome IS NULL)
           OR (reconciliation_outcome = ANY (ARRAY['PROVIDER_CORRECTED_NOT_PAID'::text,
                                                   'EXTERNALLY_VOIDED'::text,
                                                   'FINANCE_CLOSED_EXCEPTION'::text]))),
  -- `LIFE-DEC-002` / §4.2: an upgrade quote is a per-month difference times the
  -- remaining whole service months, effective at a boundary. A renewal quote is
  -- a term of whole months at the target's monthly price. Neither shape can be
  -- written as the other, and an upgrade to a lower package is unrepresentable.
  CONSTRAINT subscription_billing_intent_renewal_shape
    CHECK ((kind <> 'RENEWAL'::text)
           OR (term_months = ANY (ARRAY[1, 3, 7, 12])
               AND price_delta_mnt IS NULL
               AND remaining_service_months IS NULL
               AND effective_at IS NULL
               AND amount_mnt = (monthly_price_mnt * term_months) - discount_mnt)),
  CONSTRAINT subscription_billing_intent_upgrade_shape
    CHECK ((kind <> 'UPGRADE'::text)
           OR (term_months IS NULL
               AND price_delta_mnt IS NOT NULL
               AND remaining_service_months IS NOT NULL
               AND remaining_service_months >= 1
               AND effective_at IS NOT NULL
               AND platform.package_rank(target_package)
                   > platform.package_rank(current_package)
               AND amount_mnt = price_delta_mnt * remaining_service_months)),
  -- `LIFE-DEC-001` and §3: a renewal never quotes below the floor it inherited.
  CONSTRAINT subscription_billing_intent_renewal_not_below_floor
    CHECK ((kind <> 'RENEWAL'::text)
           OR (platform.package_rank(target_package)
               >= platform.package_rank(current_package))),
  CONSTRAINT subscription_billing_intent_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT subscription_billing_intent_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'PAID'::text, 'FAILED'::text,
                              'EXPIRED'::text, 'CANCELLED'::text, 'STALE'::text,
                              'PAID_REQUIRES_RECONCILIATION'::text])),
  CONSTRAINT subscription_billing_intent_terminal_has_time
    CHECK ((state = 'PENDING'::text) = (terminal_at IS NULL)),
  CONSTRAINT subscription_billing_intent_vat_rate_range CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  CONSTRAINT subscription_billing_intent_invoice_uq UNIQUE (provider, provider_invoice_id),
  CONSTRAINT subscription_billing_intent_scope_uq UNIQUE (hotel_id, intent_id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX subscription_billing_intent_active_uq
  ON platform.subscription_billing_intent (subscription_id)
  WHERE state = 'PENDING'::text;
--> statement-breakpoint
CREATE UNIQUE INDEX subscription_billing_intent_provider_payment_uq
  ON platform.subscription_billing_intent (provider, provider_payment_id)
  WHERE provider_payment_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX subscription_billing_intent_reconciliation_idx
  ON platform.subscription_billing_intent (state, confirmed_at)
  WHERE state = 'PAID_REQUIRES_RECONCILIATION'::text;
--> statement-breakpoint

-- doc 16 §4: what was actually collected, immutable. `SUB-DEC-006`/`SUB-DEC-007`:
-- the customer's price is VAT-inclusive, and the provider fee is the platform's
-- cost — recorded beside the gross and the net, never added to either.
CREATE TABLE platform.subscription_payment (
  payment_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id                uuid NOT NULL,
  subscription_id         uuid NOT NULL,
  purpose                 text NOT NULL,
  provider                text NOT NULL,
  provider_payment_id     text NOT NULL,
  merchant_ref            text NOT NULL,
  gross_amount_mnt        bigint NOT NULL,
  vat_amount_mnt          bigint NOT NULL,
  provider_fee_mnt        bigint NOT NULL DEFAULT 0,
  net_amount_mnt          bigint NOT NULL,
  currency                text NOT NULL DEFAULT 'MNT',
  vat_rate_bp             integer NOT NULL,
  package_code            text NOT NULL,
  term_months             integer,
  monthly_price_mnt       bigint NOT NULL,
  discount_mnt            bigint NOT NULL DEFAULT 0,
  price_book_version      text NOT NULL,
  tax_config_version      text NOT NULL,
  package_feature_version text NOT NULL,
  application_id          uuid,
  intent_id               uuid,
  confirmed_at            timestamptz NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_payment_subscription_fkey FOREIGN KEY (hotel_id, subscription_id)
    REFERENCES platform.hotel_subscription (hotel_id, subscription_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_payment_application_fkey FOREIGN KEY (application_id)
    REFERENCES platform.onboarding_application (application_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_payment_intent_fkey FOREIGN KEY (hotel_id, intent_id)
    REFERENCES platform.subscription_billing_intent (hotel_id, intent_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_payment_amounts_positive
    CHECK (gross_amount_mnt > 0 AND vat_amount_mnt >= 0 AND provider_fee_mnt >= 0),
  CONSTRAINT subscription_payment_currency_known CHECK (currency = 'MNT'::text),
  CONSTRAINT subscription_payment_discount_zero CHECK (discount_mnt = 0),
  CONSTRAINT subscription_payment_net_is_gross_less_fee
    CHECK (net_amount_mnt = gross_amount_mnt - provider_fee_mnt),
  CONSTRAINT subscription_payment_package_known
    CHECK (package_code = ANY (ARRAY['P20'::text, 'P25'::text, 'P30'::text])),
  CONSTRAINT subscription_payment_purpose_known
    CHECK (purpose = ANY (ARRAY['ONBOARDING'::text, 'RENEWAL'::text, 'UPGRADE'::text])),
  CONSTRAINT subscription_payment_provider_known
    CHECK (provider = ANY (ARRAY['QPAY'::text, 'KHAAN'::text])),
  CONSTRAINT subscription_payment_source_named
    CHECK (num_nonnulls(application_id, intent_id) = 1),
  CONSTRAINT subscription_payment_term_matches_purpose
    CHECK ((purpose = 'UPGRADE'::text) = (term_months IS NULL)),
  CONSTRAINT subscription_payment_vat_within_gross CHECK (vat_amount_mnt <= gross_amount_mnt),
  CONSTRAINT subscription_payment_vat_rate_range CHECK (vat_rate_bp BETWEEN 0 AND 10000),
  CONSTRAINT subscription_payment_provider_uq UNIQUE (provider, provider_payment_id),
  CONSTRAINT subscription_payment_scope_uq UNIQUE (hotel_id, payment_id)
);
--> statement-breakpoint

CREATE INDEX subscription_payment_subscription_idx
  ON platform.subscription_payment (hotel_id, subscription_id, confirmed_at);
--> statement-breakpoint

-- doc 17 §4: the paid upgrade and renewal history, append-only. A package or an
-- expiry that moved is a new row, never an edit to an old one (ADR-0009).
CREATE TABLE platform.subscription_event (
  event_id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hotel_id         uuid NOT NULL,
  subscription_id  uuid NOT NULL,
  event_type       text NOT NULL,
  billing_revision integer NOT NULL,
  from_package     text,
  to_package       text,
  from_expires_at  timestamptz,
  to_expires_at    timestamptz,
  payment_id       uuid,
  actor_ref        text NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_event_subscription_fkey FOREIGN KEY (hotel_id, subscription_id)
    REFERENCES platform.hotel_subscription (hotel_id, subscription_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_event_payment_fkey FOREIGN KEY (hotel_id, payment_id)
    REFERENCES platform.subscription_payment (hotel_id, payment_id) ON DELETE RESTRICT,
  CONSTRAINT subscription_event_billing_revision_positive CHECK (billing_revision >= 1),
  CONSTRAINT subscription_event_detail_sanitised
    CHECK (NOT platform.contains_denied_key(detail)),
  CONSTRAINT subscription_event_type_known
    CHECK (event_type = ANY (ARRAY['PROVISIONED'::text, 'RENEWED'::text,
                                   'UPGRADE_PAID'::text, 'UPGRADE_APPLIED'::text,
                                   'SUSPENDED'::text, 'REACTIVATED'::text]))
);
--> statement-breakpoint

CREATE INDEX subscription_event_subscription_idx
  ON platform.subscription_event (hotel_id, subscription_id, event_id);
--> statement-breakpoint

-- `SUB-DEC-005` / `SUB-DEC-008`, doc 16 §4.1. One issuance intent per confirmed
-- payment, a leased retry queue for the failures, and receipt fields that only
-- the port can supply: they are written together or not at all, and they cannot
-- be rewritten afterwards.
CREATE TABLE platform.ebarimt_issuance (
  issuance_id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id              uuid NOT NULL,
  payment_id            uuid NOT NULL,
  state                 text NOT NULL DEFAULT 'PENDING',
  attempts              integer NOT NULL DEFAULT 0,
  available_at          timestamptz NOT NULL DEFAULT now(),
  claim_token           uuid,
  claimed_until         timestamptz,
  receipt_number        text,
  receipt_qr            text,
  receipt_amount_mnt    bigint,
  receipt_vat_amount_mnt bigint,
  receipt_issued_at     timestamptz,
  delivery_state        text NOT NULL DEFAULT 'PENDING',
  delivered_at          timestamptz,
  last_error            text,
  retried_by_account_id uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  revision              integer NOT NULL DEFAULT 0,
  CONSTRAINT ebarimt_issuance_payment_fkey FOREIGN KEY (hotel_id, payment_id)
    REFERENCES platform.subscription_payment (hotel_id, payment_id) ON DELETE RESTRICT,
  CONSTRAINT ebarimt_issuance_retried_by_fkey FOREIGN KEY (retried_by_account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT ebarimt_issuance_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT ebarimt_issuance_claim_complete
    CHECK (num_nonnulls(claim_token, claimed_until) = ANY (ARRAY[0, 2])),
  CONSTRAINT ebarimt_issuance_delivery_state_known
    CHECK (delivery_state = ANY (ARRAY['PENDING'::text, 'SENT'::text, 'FAILED'::text])),
  CONSTRAINT ebarimt_issuance_delivered_has_time
    CHECK ((delivery_state = 'SENT'::text) = (delivered_at IS NOT NULL)),
  -- doc 16 §4.1: nothing is marked sent before the receipt officially exists.
  CONSTRAINT ebarimt_issuance_delivery_requires_issue
    CHECK ((delivery_state = 'PENDING'::text) OR (state = 'ISSUED'::text)),
  -- The operator never invents a number, a QR, a tax figure or a reference.
  -- Either the port supplied all four or the row holds none of them.
  CONSTRAINT ebarimt_issuance_receipt_complete
    CHECK (num_nonnulls(receipt_number, receipt_qr, receipt_amount_mnt,
                        receipt_vat_amount_mnt, receipt_issued_at) = ANY (ARRAY[0, 5])),
  CONSTRAINT ebarimt_issuance_receipt_matches_state
    CHECK ((state = 'ISSUED'::text) = (receipt_number IS NOT NULL)),
  CONSTRAINT ebarimt_issuance_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT ebarimt_issuance_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text, 'ISSUED'::text,
                              'MANUAL_RESOLUTION'::text])),
  CONSTRAINT ebarimt_issuance_payment_uq UNIQUE (hotel_id, payment_id),
  CONSTRAINT ebarimt_issuance_scope_uq UNIQUE (hotel_id, issuance_id)
);
--> statement-breakpoint

CREATE INDEX ebarimt_issuance_queue_idx
  ON platform.ebarimt_issuance (available_at, issuance_id)
  WHERE state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text]);
--> statement-breakpoint
CREATE INDEX ebarimt_issuance_manual_idx
  ON platform.ebarimt_issuance (hotel_id, created_at)
  WHERE state = 'MANUAL_RESOLUTION'::text;
--> statement-breakpoint

-- doc 24 §2.1: exactly one `Үндсэн касс` is created when a hotel's subscription
-- activates. Only the cash-location root is introduced here — shifts, movements,
-- balances, expenses, safes and the cash APIs are Phase 11, and this table
-- carries none of them.
CREATE TABLE platform.cash_location (
  cash_location_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id          uuid NOT NULL,
  kind              text NOT NULL,
  name              text NOT NULL,
  code              text NOT NULL,
  state             text NOT NULL DEFAULT 'ACTIVE',
  is_default_drawer boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revision          integer NOT NULL DEFAULT 0,
  CONSTRAINT cash_location_hotel_fkey FOREIGN KEY (hotel_id)
    REFERENCES platform.hotel (hotel_id) ON DELETE RESTRICT,
  CONSTRAINT cash_location_default_is_a_drawer
    CHECK ((NOT is_default_drawer) OR (kind = 'DRAWER'::text)),
  CONSTRAINT cash_location_default_is_active
    CHECK ((NOT is_default_drawer) OR (state = 'ACTIVE'::text)),
  CONSTRAINT cash_location_kind_known
    CHECK (kind = ANY (ARRAY['DRAWER'::text, 'SAFE'::text])),
  CONSTRAINT cash_location_name_bounded CHECK (length(name) BETWEEN 1 AND 100),
  CONSTRAINT cash_location_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT cash_location_state_known
    CHECK (state = ANY (ARRAY['ACTIVE'::text, 'INACTIVE'::text])),
  CONSTRAINT cash_location_code_uq UNIQUE (hotel_id, code),
  CONSTRAINT cash_location_name_uq UNIQUE (hotel_id, name),
  CONSTRAINT cash_location_scope_uq UNIQUE (hotel_id, cash_location_id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX cash_location_default_drawer_uq
  ON platform.cash_location (hotel_id)
  WHERE is_default_drawer IS TRUE;
--> statement-breakpoint

-- doc 15 §6 and §7: the first Hotel Admin's own axis, separate from the hotel,
-- the subscription and the public listing.
--
-- A new admin's row is `PENDING_ACTIVATION` and carries the digest of a
-- single-use link. A proved existing active account's row is `ACTIVE` from the
-- start and carries no token at all — `ONB-DEC-003` forbids minting a second
-- credential artefact for an account that already has one.
CREATE TABLE platform.hotel_admin_activation (
  activation_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id          uuid NOT NULL,
  membership_id     uuid NOT NULL,
  account_id        uuid NOT NULL,
  application_id    uuid NOT NULL,
  state             text NOT NULL DEFAULT 'PENDING_ACTIVATION',
  token_hash        text,
  token_key_version text,
  email_normalized  text NOT NULL,
  expires_at        timestamptz,
  activated_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  revision          integer NOT NULL DEFAULT 0,
  CONSTRAINT hotel_admin_activation_membership_fkey FOREIGN KEY (hotel_id, membership_id)
    REFERENCES platform.staff_membership (hotel_id, membership_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_admin_activation_account_fkey FOREIGN KEY (account_id)
    REFERENCES platform.user_account (account_id) ON DELETE RESTRICT,
  CONSTRAINT hotel_admin_activation_application_fkey FOREIGN KEY (application_id)
    REFERENCES platform.onboarding_application (application_id) ON DELETE RESTRICT,
  -- Set exactly when activation has happened. A Hotel Admin who is later
  -- suspended still activated, so the marker is tied to `PENDING_ACTIVATION`
  -- being over rather than to the row currently reading `ACTIVE`.
  CONSTRAINT hotel_admin_activation_activated_has_time
    CHECK ((state = 'PENDING_ACTIVATION'::text) = (activated_at IS NULL)),
  CONSTRAINT hotel_admin_activation_email_normalised
    CHECK (email_normalized = lower(email_normalized)),
  CONSTRAINT hotel_admin_activation_state_known
    CHECK (state = ANY (ARRAY['PENDING_ACTIVATION'::text, 'ACTIVE'::text, 'SUSPENDED'::text])),
  -- A live token exists only while activation is pending, and it always has its
  -- key version and its expiry beside it.
  CONSTRAINT hotel_admin_activation_token_complete
    CHECK (num_nonnulls(token_hash, token_key_version, expires_at) = ANY (ARRAY[0, 3])),
  CONSTRAINT hotel_admin_activation_token_only_while_pending
    CHECK ((token_hash IS NULL) OR (state = 'PENDING_ACTIVATION'::text)),
  CONSTRAINT hotel_admin_activation_token_shape
    CHECK ((token_hash IS NULL) OR (token_hash ~ '^[0-9a-f]{64}$'::text)),
  CONSTRAINT hotel_admin_activation_revision_non_negative CHECK (revision >= 0),
  CONSTRAINT hotel_admin_activation_membership_uq UNIQUE (hotel_id, membership_id),
  CONSTRAINT hotel_admin_activation_application_uq UNIQUE (application_id),
  CONSTRAINT hotel_admin_activation_token_uq UNIQUE (token_hash),
  CONSTRAINT hotel_admin_activation_scope_uq UNIQUE (hotel_id, activation_id)
);
--> statement-breakpoint

-- doc 15 §5: the activation email is an outbox delivery, separate from the
-- provisioning transaction. It carries the sealed one-time secret so a delivery
-- failure costs a retry rather than the whole provisioning — and so the secret
-- is never held in a process's memory between the two.
CREATE TABLE platform.activation_delivery (
  delivery_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hotel_id           uuid NOT NULL,
  activation_id      uuid NOT NULL,
  email_normalized   text NOT NULL,
  secret_ciphertext  bytea,
  secret_wrapped_dek bytea,
  secret_key_version text,
  expires_at         timestamptz NOT NULL,
  state              text NOT NULL DEFAULT 'PENDING',
  attempts           integer NOT NULL DEFAULT 0,
  available_at       timestamptz NOT NULL DEFAULT now(),
  claim_token        uuid,
  claimed_until      timestamptz,
  delivered_at       timestamptz,
  last_error         text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activation_delivery_activation_fkey FOREIGN KEY (hotel_id, activation_id)
    REFERENCES platform.hotel_admin_activation (hotel_id, activation_id) ON DELETE RESTRICT,
  CONSTRAINT activation_delivery_attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT activation_delivery_claim_complete
    CHECK (num_nonnulls(claim_token, claimed_until) = ANY (ARRAY[0, 2])),
  CONSTRAINT activation_delivery_delivered_has_time
    CHECK ((state = 'SENT'::text) = (delivered_at IS NOT NULL)),
  CONSTRAINT activation_delivery_email_normalised
    CHECK (email_normalized = lower(email_normalized)),
  CONSTRAINT activation_delivery_secret_complete
    CHECK (num_nonnulls(secret_ciphertext, secret_wrapped_dek, secret_key_version)
           = ANY (ARRAY[0, 3])),
  -- A delivered or dead-lettered row holds no secret. The sealed value exists
  -- only while there is still something to deliver.
  CONSTRAINT activation_delivery_settled_holds_no_secret
    CHECK ((secret_ciphertext IS NULL)
           OR (state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text]))),
  CONSTRAINT activation_delivery_state_known
    CHECK (state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text, 'SENT'::text,
                              'DEAD_LETTER'::text])),
  CONSTRAINT activation_delivery_activation_uq UNIQUE (hotel_id, activation_id)
);
--> statement-breakpoint

CREATE INDEX activation_delivery_queue_idx
  ON platform.activation_delivery (available_at, delivery_id)
  WHERE state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text]);
--> statement-breakpoint

-- =====================================================================
-- Guards — transition rules the grants and CHECKs cannot express
-- =====================================================================

-- doc 15 §7: the canonical transition table, and the rule that a paid state
-- never returns to an unpaid one. Invoker-rights: they refuse, never widen.
CREATE OR REPLACE FUNCTION platform.onboarding_application_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an onboarding application is evidence, not scratch space'
      USING ERRCODE = '42501';
  END IF;

  -- The commercial terms, the owner identifier and the applicant's bearer digest
  -- are what the invoice was quoted against. A retry may not edit any of them
  -- (`ONB-DEC-006`).
  IF NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.owner_type IS DISTINCT FROM OLD.owner_type
     OR NEW.package_code IS DISTINCT FROM OLD.package_code
     OR NEW.term_months IS DISTINCT FROM OLD.term_months
     OR NEW.monthly_price_mnt IS DISTINCT FROM OLD.monthly_price_mnt
     OR NEW.discount_mnt IS DISTINCT FROM OLD.discount_mnt
     OR NEW.total_amount_mnt IS DISTINCT FROM OLD.total_amount_mnt
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.vat_rate_bp IS DISTINCT FROM OLD.vat_rate_bp
     OR NEW.price_book_version IS DISTINCT FROM OLD.price_book_version
     OR NEW.tax_config_version IS DISTINCT FROM OLD.tax_config_version
     OR NEW.package_feature_version IS DISTINCT FROM OLD.package_feature_version
     OR NEW.owner_identifier_lookup_token IS DISTINCT FROM OLD.owner_identifier_lookup_token
     OR NEW.owner_identifier_ciphertext IS DISTINCT FROM OLD.owner_identifier_ciphertext
     OR NEW.admin_email_normalized IS DISTINCT FROM OLD.admin_email_normalized
     OR NEW.applicant_token_hash IS DISTINCT FROM OLD.applicant_token_hash THEN
    RAISE EXCEPTION 'the quoted terms, the owner identifier and the applicant reference are immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;

  -- `ONB-DEC-006`: the payment that made this application paid never changes,
  -- and neither does the instant it was confirmed at. A retry that could move
  -- either would move `starts_at` with it.
  IF OLD.paid_attempt_id IS NOT NULL
     AND (NEW.paid_attempt_id IS DISTINCT FROM OLD.paid_attempt_id
          OR NEW.payment_confirmed_at IS DISTINCT FROM OLD.payment_confirmed_at) THEN
    RAISE EXCEPTION 'the confirmed payment of a paid application is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.owner_id IS NOT NULL AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'an application never moves to another owner' USING ERRCODE = '42501';
  END IF;
  IF OLD.provisioned_hotel_id IS NOT NULL
     AND NEW.provisioned_hotel_id IS DISTINCT FROM OLD.provisioned_hotel_id THEN
    RAISE EXCEPTION 'an application never moves to another hotel' USING ERRCODE = '42501';
  END IF;
  IF OLD.contact_phone_verified_at IS NOT NULL
     AND NEW.contact_phone_verified_at IS DISTINCT FROM OLD.contact_phone_verified_at THEN
    RAISE EXCEPTION 'a completed phone verification is not re-dated' USING ERRCODE = '42501';
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  v_allowed := CASE OLD.state
    WHEN 'DRAFT' THEN ARRAY['OWNER_VERIFICATION_REQUIRED', 'PENDING_PAYMENT']
    WHEN 'OWNER_VERIFICATION_REQUIRED' THEN ARRAY['PENDING_PAYMENT']
    WHEN 'PENDING_PAYMENT' THEN ARRAY['PAYMENT_UNCERTAIN', 'PAYMENT_FAILED', 'PAYMENT_EXPIRED',
                                      'PAID_PENDING_PROVISIONING',
                                      'PAID_OWNER_VERIFICATION_REQUIRED']
    WHEN 'PAYMENT_UNCERTAIN' THEN ARRAY['PAID_PENDING_PROVISIONING',
                                        'PAID_OWNER_VERIFICATION_REQUIRED',
                                        'PAYMENT_FAILED', 'PAYMENT_EXPIRED']
    WHEN 'PAYMENT_FAILED' THEN ARRAY['PENDING_PAYMENT']
    WHEN 'PAYMENT_EXPIRED' THEN ARRAY['PENDING_PAYMENT']
    WHEN 'PAID_OWNER_VERIFICATION_REQUIRED' THEN ARRAY['PAID_PENDING_PROVISIONING']
    WHEN 'PAID_PENDING_PROVISIONING' THEN ARRAY['PAID_OWNER_VERIFICATION_REQUIRED', 'PROVISIONING']
    WHEN 'PROVISIONING' THEN ARRAY['PROVISIONED', 'PROVISIONING_FAILED']
    WHEN 'PROVISIONING_FAILED' THEN ARRAY['PROVISIONING']
    WHEN 'PROVISIONED' THEN ARRAY[]::text[]
  END;

  IF NOT (NEW.state = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'an onboarding application does not move from % to %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- doc 15 §3.1: an owner's stored, verified contact channels are what a future
-- proof is sent to. A new application must never be able to overwrite them —
-- doing so would turn "prove you are the owner" into "tell us where to ask".
CREATE OR REPLACE FUNCTION platform.subscription_owner_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an owner profile is never hard deleted' USING ERRCODE = '42501';
  END IF;

  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id
     OR NEW.owner_type IS DISTINCT FROM OLD.owner_type
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.identity_type IS DISTINCT FROM OLD.identity_type
     OR NEW.country_code IS DISTINCT FROM OLD.country_code
     OR NEW.identifier_ciphertext IS DISTINCT FROM OLD.identifier_ciphertext
     OR NEW.identifier_lookup_token IS DISTINCT FROM OLD.identifier_lookup_token THEN
    RAISE EXCEPTION 'an owner identity is immutable; a change of owner is a separate controlled flow'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.verified_email_normalized IS NOT NULL
     AND NEW.verified_email_normalized IS DISTINCT FROM OLD.verified_email_normalized THEN
    RAISE EXCEPTION 'a stored verified owner contact is not overwritten by a later application'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.verified_phone IS NOT NULL AND NEW.verified_phone IS DISTINCT FROM OLD.verified_phone THEN
    RAISE EXCEPTION 'a stored verified owner contact is not overwritten by a later application'
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

-- doc 15 §4.1 / `ONB-DEC-008`: an attempt's money is immutable and a terminal
-- attempt stays terminal. The one exception is the reconciliation queue, whose
-- whole purpose is to close a `PAID_REQUIRES_RECONCILIATION` case with evidence
-- — and which may not touch the amount, the provider or the confirmation.
CREATE OR REPLACE FUNCTION platform.onboarding_payment_attempt_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a payment attempt is financial history' USING ERRCODE = '42501';
  END IF;

  IF NEW.attempt_id IS DISTINCT FROM OLD.attempt_id
     OR NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.merchant_ref IS DISTINCT FROM OLD.merchant_ref
     OR NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.package_code IS DISTINCT FROM OLD.package_code
     OR NEW.term_months IS DISTINCT FROM OLD.term_months
     OR NEW.monthly_price_mnt IS DISTINCT FROM OLD.monthly_price_mnt
     OR NEW.discount_mnt IS DISTINCT FROM OLD.discount_mnt
     OR NEW.vat_rate_bp IS DISTINCT FROM OLD.vat_rate_bp
     OR NEW.price_book_version IS DISTINCT FROM OLD.price_book_version
     OR NEW.tax_config_version IS DISTINCT FROM OLD.tax_config_version
     OR NEW.package_feature_version IS DISTINCT FROM OLD.package_feature_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'the terms of a payment attempt are immutable' USING ERRCODE = '42501';
  END IF;

  IF OLD.provider_payment_id IS NOT NULL
     AND (NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id
          OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
    RAISE EXCEPTION 'a confirmed provider payment is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  v_allowed := CASE OLD.state
    WHEN 'PENDING' THEN ARRAY['PAYMENT_UNCERTAIN', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED',
                              'PAID_REQUIRES_RECONCILIATION']
    WHEN 'PAYMENT_UNCERTAIN' THEN ARRAY['PAID', 'FAILED', 'EXPIRED',
                                        'PAID_REQUIRES_RECONCILIATION']
    -- A late success on an attempt that already expired or failed is the
    -- duplicate-capture case, never a resurrection of the attempt.
    WHEN 'EXPIRED' THEN ARRAY['PAID', 'PAID_REQUIRES_RECONCILIATION']
    WHEN 'FAILED' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
    WHEN 'CANCELLED' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.state = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'a payment attempt does not move from % to %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- `OPS-DEC-006` / `OPS-DEC-007` / `LIFE-DEC-001`: the start never moves, the
-- expiry only ever moves forward, the floor never falls, and the billing
-- revision is monotonic so a callback and the boundary worker cannot both win.
CREATE OR REPLACE FUNCTION platform.hotel_subscription_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
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

  -- `OPS-DEC-006` and `OPS-DEC-007`: `starts_at` is a confirmed payment instant
  -- and only ever moves **forward** — a renewal that lands after grace begins a
  -- new paid window at its own confirmation, and there is no live window left
  -- for it to continue from.
  --
  -- Backwards is the direction that would be a lie: it would extend a paid
  -- window into time nobody paid for. A duplicate callback, a provisioning retry
  -- and an email retry all leave the value alone, and the billing-revision
  -- compare-and-set is what makes that structural rather than hoped for.
  IF NEW.starts_at < OLD.starts_at THEN
    RAISE EXCEPTION 'starts_at never moves backwards (was %, offered %)',
      OLD.starts_at, NEW.starts_at USING ERRCODE = '42501';
  END IF;

  -- `LIFE-DEC-002`: an upgrade never shortens or extends the term; a renewal
  -- only ever adds to it.
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

  IF NEW.billing_revision <= OLD.billing_revision THEN
    RAISE EXCEPTION 'billing_revision must increase (was %, offered %)',
      OLD.billing_revision, NEW.billing_revision USING ERRCODE = '40001';
  END IF;
  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;

  -- §4.3: a pending target may only be raised, and once applied it is cleared
  -- rather than lowered. The boundary the entitlement opens at is fixed when the
  -- first upgrade is paid, and a second incremental upgrade inherits it.
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

-- doc 17 §4.4: a quote's money and its snapshot are immutable, and a terminal
-- intent stays terminal.
CREATE OR REPLACE FUNCTION platform.subscription_billing_intent_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a billing intent is financial history' USING ERRCODE = '42501';
  END IF;

  IF NEW.intent_id IS DISTINCT FROM OLD.intent_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.subscription_id IS DISTINCT FROM OLD.subscription_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.merchant_ref IS DISTINCT FROM OLD.merchant_ref
     OR NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.discount_mnt IS DISTINCT FROM OLD.discount_mnt
     OR NEW.quoted_billing_revision IS DISTINCT FROM OLD.quoted_billing_revision
     OR NEW.current_package IS DISTINCT FROM OLD.current_package
     OR NEW.target_package IS DISTINCT FROM OLD.target_package
     OR NEW.term_months IS DISTINCT FROM OLD.term_months
     OR NEW.monthly_price_mnt IS DISTINCT FROM OLD.monthly_price_mnt
     OR NEW.price_delta_mnt IS DISTINCT FROM OLD.price_delta_mnt
     OR NEW.remaining_service_months IS DISTINCT FROM OLD.remaining_service_months
     OR NEW.effective_at IS DISTINCT FROM OLD.effective_at
     OR NEW.quoted_expires_at IS DISTINCT FROM OLD.quoted_expires_at
     OR NEW.vat_rate_bp IS DISTINCT FROM OLD.vat_rate_bp
     OR NEW.price_book_version IS DISTINCT FROM OLD.price_book_version
     OR NEW.tax_config_version IS DISTINCT FROM OLD.tax_config_version
     OR NEW.package_feature_version IS DISTINCT FROM OLD.package_feature_version
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'a billing quote is immutable; a new price is a new intent'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.provider_payment_id IS NOT NULL
     AND (NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id
          OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
    RAISE EXCEPTION 'a confirmed provider payment is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;

  IF NEW.state = OLD.state THEN
    RETURN NEW;
  END IF;

  v_allowed := CASE OLD.state
    WHEN 'PENDING' THEN ARRAY['PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'STALE',
                              'PAID_REQUIRES_RECONCILIATION']
    -- A late capture on an intent that was superseded, cancelled or expired is
    -- the reconciliation case of `LIFE-DEC-006`, never an entitlement.
    WHEN 'STALE' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
    WHEN 'CANCELLED' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
    WHEN 'EXPIRED' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
    WHEN 'FAILED' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (NEW.state = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'a billing intent does not move from % to %', OLD.state, NEW.state
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- doc 16 §4.1: the operator never writes a receipt field. Once the port has
-- supplied them they are frozen, and an `ISSUED` issuance never reopens.
CREATE OR REPLACE FUNCTION platform.ebarimt_issuance_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an eBarimt issuance record is financial evidence' USING ERRCODE = '42501';
  END IF;

  IF NEW.issuance_id IS DISTINCT FROM OLD.issuance_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.payment_id IS DISTINCT FROM OLD.payment_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an issuance identity is immutable' USING ERRCODE = '42501';
  END IF;

  IF OLD.receipt_number IS NOT NULL
     AND (NEW.receipt_number IS DISTINCT FROM OLD.receipt_number
          OR NEW.receipt_qr IS DISTINCT FROM OLD.receipt_qr
          OR NEW.receipt_amount_mnt IS DISTINCT FROM OLD.receipt_amount_mnt
          OR NEW.receipt_vat_amount_mnt IS DISTINCT FROM OLD.receipt_vat_amount_mnt
          OR NEW.receipt_issued_at IS DISTINCT FROM OLD.receipt_issued_at) THEN
    RAISE EXCEPTION 'an official receipt is never rewritten' USING ERRCODE = '42501';
  END IF;

  IF OLD.state = 'ISSUED' AND NEW.state <> 'ISSUED' THEN
    RAISE EXCEPTION 'an issued receipt does not return to %', NEW.state USING ERRCODE = '22023';
  END IF;

  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- doc 15 §5 / `ONB-DEC-003`: activation happens once. The link is destroyed on
-- success and never re-attached, and the membership it belongs to never moves.
CREATE OR REPLACE FUNCTION platform.hotel_admin_activation_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an activation record is evidence' USING ERRCODE = '42501';
  END IF;

  IF NEW.activation_id IS DISTINCT FROM OLD.activation_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.application_id IS DISTINCT FROM OLD.application_id
     OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an activation identity is immutable' USING ERRCODE = '42501';
  END IF;

  -- Destroy-only. A token may be cleared when the link is redeemed or expires;
  -- it may never be replaced in place, because that would be a second link
  -- nobody minted through the issuing path.
  IF NEW.token_hash IS NOT NULL
     AND (OLD.token_hash IS NULL
          OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
          OR NEW.token_key_version IS DISTINCT FROM OLD.token_key_version
          OR NEW.expires_at IS DISTINCT FROM OLD.expires_at) THEN
    RAISE EXCEPTION 'an activation link is destroyed, never rewritten or attached'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.state = 'ACTIVE' AND NEW.state = 'PENDING_ACTIVATION' THEN
    RAISE EXCEPTION 'an activated Hotel Admin does not return to PENDING_ACTIVATION'
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

-- The same rules the reset intake earned: a settled delivery is terminal, its
-- sealed secret is destroyed rather than rewritten, and the row is not deletable
-- by the runtime that drains it.
CREATE OR REPLACE FUNCTION platform.activation_delivery_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a settled activation delivery is evidence, not scratch space'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.delivery_id IS DISTINCT FROM OLD.delivery_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.activation_id IS DISTINCT FROM OLD.activation_id
     OR NEW.email_normalized IS DISTINCT FROM OLD.email_normalized
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a delivery identity is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.secret_ciphertext IS NOT NULL
     AND (OLD.secret_ciphertext IS NULL
          OR NEW.secret_ciphertext IS DISTINCT FROM OLD.secret_ciphertext
          OR NEW.secret_wrapped_dek IS DISTINCT FROM OLD.secret_wrapped_dek
          OR NEW.secret_key_version IS DISTINCT FROM OLD.secret_key_version) THEN
    RAISE EXCEPTION 'a sealed delivery secret is destroyed, never rewritten or attached'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.state = ANY (ARRAY['SENT'::text, 'DEAD_LETTER'::text]) THEN
    RAISE EXCEPTION 'activation delivery % is already %', OLD.delivery_id, OLD.state
      USING ERRCODE = '22023';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

-- doc 24 §2.1: a used cash location is never hard deleted, and the default
-- drawer is created by provisioning rather than by a staff action.
CREATE OR REPLACE FUNCTION platform.cash_location_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a cash location is deactivated, never deleted (doc 24 §2.2)'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.cash_location_id IS DISTINCT FROM OLD.cash_location_id
     OR NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a cash location identity is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.is_default_drawer IS DISTINCT FROM OLD.is_default_drawer THEN
    RAISE EXCEPTION 'the default drawer is established at provisioning (doc 24 §2.1)'
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

-- doc 15 §5.1 and §6: publication is its own axis and it never opens while a
-- duplicate review is outstanding.
CREATE OR REPLACE FUNCTION platform.hotel_profile_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'a hotel profile is not deleted' USING ERRCODE = '42501';
  END IF;

  IF NEW.hotel_id IS DISTINCT FROM OLD.hotel_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a hotel profile identity is immutable' USING ERRCODE = '42501';
  END IF;

  IF NEW.revision <= OLD.revision THEN
    RAISE EXCEPTION 'revision must increase (was %, offered %)', OLD.revision, NEW.revision
      USING ERRCODE = '40001';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER onboarding_application_no_delete
  BEFORE DELETE ON platform.onboarding_application
  FOR EACH ROW EXECUTE FUNCTION platform.onboarding_application_guard();
--> statement-breakpoint
CREATE TRIGGER onboarding_application_transition_guard
  BEFORE UPDATE ON platform.onboarding_application
  FOR EACH ROW EXECUTE FUNCTION platform.onboarding_application_guard();
--> statement-breakpoint
CREATE TRIGGER subscription_owner_no_delete
  BEFORE DELETE ON platform.subscription_owner
  FOR EACH ROW EXECUTE FUNCTION platform.subscription_owner_guard();
--> statement-breakpoint
CREATE TRIGGER subscription_owner_transition_guard
  BEFORE UPDATE ON platform.subscription_owner
  FOR EACH ROW EXECUTE FUNCTION platform.subscription_owner_guard();
--> statement-breakpoint
CREATE TRIGGER onboarding_payment_attempt_no_delete
  BEFORE DELETE ON platform.onboarding_payment_attempt
  FOR EACH ROW EXECUTE FUNCTION platform.onboarding_payment_attempt_guard();
--> statement-breakpoint
CREATE TRIGGER onboarding_payment_attempt_transition_guard
  BEFORE UPDATE ON platform.onboarding_payment_attempt
  FOR EACH ROW EXECUTE FUNCTION platform.onboarding_payment_attempt_guard();
--> statement-breakpoint
CREATE TRIGGER onboarding_event_append_only
  BEFORE UPDATE OR DELETE ON platform.onboarding_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER onboarding_event_no_truncate
  BEFORE TRUNCATE ON platform.onboarding_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER hotel_profile_no_delete
  BEFORE DELETE ON platform.hotel_profile
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_profile_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_profile_transition_guard
  BEFORE UPDATE ON platform.hotel_profile
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_profile_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_owner_link_append_only
  BEFORE UPDATE OR DELETE ON platform.hotel_owner_link
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER hotel_subscription_no_delete
  BEFORE DELETE ON platform.hotel_subscription
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_subscription_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_subscription_transition_guard
  BEFORE UPDATE ON platform.hotel_subscription
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_subscription_guard();
--> statement-breakpoint
CREATE TRIGGER subscription_billing_intent_no_delete
  BEFORE DELETE ON platform.subscription_billing_intent
  FOR EACH ROW EXECUTE FUNCTION platform.subscription_billing_intent_guard();
--> statement-breakpoint
CREATE TRIGGER subscription_billing_intent_transition_guard
  BEFORE UPDATE ON platform.subscription_billing_intent
  FOR EACH ROW EXECUTE FUNCTION platform.subscription_billing_intent_guard();
--> statement-breakpoint
-- `SUB-DEC-009`: there is no refund and no partial refund. A confirmed
-- subscription payment is therefore append-only in the strongest sense — the
-- database has no verb that could reverse one, so no API can grow one.
CREATE TRIGGER subscription_payment_append_only
  BEFORE UPDATE OR DELETE ON platform.subscription_payment
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER subscription_payment_no_truncate
  BEFORE TRUNCATE ON platform.subscription_payment
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER subscription_event_append_only
  BEFORE UPDATE OR DELETE ON platform.subscription_event
  FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER subscription_event_no_truncate
  BEFORE TRUNCATE ON platform.subscription_event
  FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation();
--> statement-breakpoint
CREATE TRIGGER ebarimt_issuance_no_delete
  BEFORE DELETE ON platform.ebarimt_issuance
  FOR EACH ROW EXECUTE FUNCTION platform.ebarimt_issuance_guard();
--> statement-breakpoint
CREATE TRIGGER ebarimt_issuance_transition_guard
  BEFORE UPDATE ON platform.ebarimt_issuance
  FOR EACH ROW EXECUTE FUNCTION platform.ebarimt_issuance_guard();
--> statement-breakpoint
CREATE TRIGGER cash_location_no_delete
  BEFORE DELETE ON platform.cash_location
  FOR EACH ROW EXECUTE FUNCTION platform.cash_location_guard();
--> statement-breakpoint
CREATE TRIGGER cash_location_transition_guard
  BEFORE UPDATE ON platform.cash_location
  FOR EACH ROW EXECUTE FUNCTION platform.cash_location_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_admin_activation_no_delete
  BEFORE DELETE ON platform.hotel_admin_activation
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_admin_activation_guard();
--> statement-breakpoint
CREATE TRIGGER hotel_admin_activation_transition_guard
  BEFORE UPDATE ON platform.hotel_admin_activation
  FOR EACH ROW EXECUTE FUNCTION platform.hotel_admin_activation_guard();
--> statement-breakpoint
CREATE TRIGGER activation_delivery_no_delete
  BEFORE DELETE ON platform.activation_delivery
  FOR EACH ROW EXECUTE FUNCTION platform.activation_delivery_guard();
--> statement-breakpoint
CREATE TRIGGER activation_delivery_transition_guard
  BEFORE UPDATE ON platform.activation_delivery
  FOR EACH ROW EXECUTE FUNCTION platform.activation_delivery_guard();
--> statement-breakpoint

-- =====================================================================
-- The provisioning boundary
-- =====================================================================

-- `ONB-DEC-001` and `ONB-DEC-006`: the one way a hotel comes into existence.
--
-- No runtime holds INSERT on `platform.hotel`, `platform.hotel_owner_link`,
-- `platform.hotel_subscription` or `platform.cash_location`. They are reachable
-- only through this function, which is owned by the same narrow, NOLOGIN role
-- that owns the D-09 wrappers — the established least-privileged boundary — and
-- which re-derives every authorising fact from the database:
--
--   * the application is `PAID_PENDING_PROVISIONING`;
--   * it names a confirmed attempt whose own state is `PAID`;
--   * the attempt's amount, currency and terms match the application's;
--   * the owner is resolved and, where an existing owner was matched, its proof
--     passed.
--
-- Nothing is taken from the caller except the application and the idempotency
-- key. It runs inside the caller's transaction, so the tenant, the owner link,
-- the subscription, the Primary membership and the default drawer commit
-- together or not at all.
CREATE OR REPLACE FUNCTION platform.provision_paid_hotel(
  p_application_id     uuid,
  p_idempotency_key    text,
  -- Minted by the caller, because the sealed activation secret's additional
  -- authenticated data is bound to it (ADR-0020 §3). A value generated here
  -- could only be bound to afterwards, and a ciphertext bound to the wrong row
  -- is one that will not decrypt — which is exactly what AAD is for.
  p_activation_id      uuid,
  p_token_hash         text,
  p_token_key_version  text,
  p_token_expires_at   timestamptz,
  p_secret_ciphertext  bytea,
  p_secret_wrapped_dek bytea,
  p_secret_key_version text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_app        platform.onboarding_application%ROWTYPE;
  v_attempt    platform.onboarding_payment_attempt%ROWTYPE;
  v_hotel_id   uuid;
  v_sub_id     uuid;
  v_membership uuid;
  v_account_id uuid;
  v_payment_id uuid;
  v_expires_at timestamptz;
  v_vat        bigint;
  v_activation uuid;
  v_proof      integer;
  v_prev_hotel text := current_setting('app.hotel_id', true);
  v_prev_ref   text := current_setting('app.onboarding_ref', true);
BEGIN
  IF p_application_id IS NULL OR p_idempotency_key IS NULL
     OR length(p_idempotency_key) < 8 THEN
    RAISE EXCEPTION 'provisioning needs an application and an idempotency key'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_app FROM platform.onboarding_application
    WHERE application_id = p_application_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such onboarding application' USING ERRCODE = '22023';
  END IF;

  -- `PROVISIONING`, not `PAID_PENDING_PROVISIONING`: the caller claims the
  -- application in a transaction of its own first, and that claim is what makes
  -- two runners unable to both start. Requiring the claimed state here is
  -- therefore stricter than requiring the payable one — an unclaimed
  -- application cannot be provisioned at all, by anybody.
  IF v_app.state <> 'PROVISIONING' THEN
    RAISE EXCEPTION 'application % is %, and provisioning runs only on a claimed one',
      v_app.application_id, v_app.state USING ERRCODE = '42501';
  END IF;

  -- `ONB-DEC-001`: the payment is re-read here, not trusted from the caller.
  SELECT * INTO v_attempt FROM platform.onboarding_payment_attempt
    WHERE attempt_id = v_app.paid_attempt_id;
  IF NOT FOUND OR v_attempt.state <> 'PAID' OR v_attempt.confirmed_at IS NULL
     OR v_attempt.application_id <> v_app.application_id THEN
    RAISE EXCEPTION 'application % has no confirmed payment', v_app.application_id
      USING ERRCODE = '42501';
  END IF;
  IF v_attempt.amount_mnt <> v_app.total_amount_mnt
     OR v_attempt.currency <> v_app.currency
     OR v_attempt.package_code <> v_app.package_code
     OR v_attempt.term_months <> v_app.term_months THEN
    RAISE EXCEPTION 'the confirmed payment does not match the quoted application terms'
      USING ERRCODE = '42501';
  END IF;
  IF v_app.payment_confirmed_at IS DISTINCT FROM v_attempt.confirmed_at THEN
    RAISE EXCEPTION 'the application and its payment disagree about the confirmation instant'
      USING ERRCODE = '42501';
  END IF;

  IF v_app.owner_id IS NULL THEN
    RAISE EXCEPTION 'provisioning needs a resolved subscription owner' USING ERRCODE = '42501';
  END IF;

  -- doc 15 §3.1: where the owner already existed, a proof must have passed.
  -- Payment alone never attaches a hotel to somebody else's owner profile.
  SELECT count(*) INTO v_proof FROM platform.onboarding_owner_proof
    WHERE application_id = v_app.application_id AND state = 'PASSED';
  IF v_proof = 0 AND EXISTS (
       SELECT 1 FROM platform.hotel_owner_link
        WHERE owner_id = v_app.owner_id AND application_id <> v_app.application_id) THEN
    RAISE EXCEPTION 'an existing owner requires a passed ownership proof (ONB-DEC-007)'
      USING ERRCODE = '42501';
  END IF;

  -- ---- the tenant
  --
  -- The definer is *not* exempt from row level security: every table below is
  -- `FORCE ROW LEVEL SECURITY` and this role does not own any of them. That is
  -- deliberate — a provisioning wrapper that bypassed the tenant policies could
  -- write a row into somebody else's hotel by getting one column wrong.
  --
  -- So the id is minted first and the scope is bound to it, which makes the
  -- ordinary tenant policy the thing that proves every row created here belongs
  -- to the hotel created here. The caller's own scope is saved and restored, so
  -- nothing about the surrounding transaction changes. The onboarding reference
  -- is bound the same way, from the row that was just locked rather than from
  -- whatever the caller happened to be carrying.
  v_hotel_id := gen_random_uuid();
  PERFORM set_config('app.hotel_id', v_hotel_id::text, true);
  PERFORM set_config('app.onboarding_ref', v_app.application_id::text, true);

  INSERT INTO platform.hotel (hotel_id, display_name)
  VALUES (v_hotel_id, v_app.hotel_display_name);

  INSERT INTO platform.hotel_profile
    (hotel_id, public_name, public_phone, district, khoroo, address_line,
     latitude_micro, longitude_micro, duplicate_review_required)
  VALUES (v_hotel_id, v_app.hotel_display_name, v_app.hotel_public_phone, v_app.district,
          v_app.khoroo, v_app.address_line, v_app.latitude_micro, v_app.longitude_micro,
          v_app.duplicate_review_required);

  INSERT INTO platform.hotel_owner_link (hotel_id, owner_id, owner_type, application_id)
  VALUES (v_hotel_id, v_app.owner_id, v_app.owner_type, v_app.application_id);

  -- ---- the subscription (`OPS-DEC-006`)
  -- `starts_at` is the confirmed payment instant; `expires_at` adds the chosen
  -- calendar months in the hotel's own timezone, clamping to the last day of a
  -- shorter target month while keeping the time of day.
  v_expires_at := platform.add_service_months(
    v_attempt.confirmed_at, v_attempt.term_months, 'Asia/Ulaanbaatar');

  INSERT INTO platform.hotel_subscription
    (hotel_id, effective_package, package_floor, term_months, starts_at, expires_at)
  VALUES (v_hotel_id, v_attempt.package_code, v_attempt.package_code, v_attempt.term_months,
          v_attempt.confirmed_at, v_expires_at)
  RETURNING subscription_id INTO v_sub_id;

  -- ---- the money, immutable (doc 16 §4)
  -- The published price is VAT-inclusive (`SUB-DEC-006`), so the tax inside it is
  -- `gross × rate / (10000 + rate)`, rounded half up. Integer arithmetic
  -- throughout — `(2ar + d) / 2d` is the half-up rounding of `ar/d` with no
  -- floating point and no numeric cast anywhere near money (CLAUDE.md §5).
  v_vat := CASE WHEN v_app.vat_rate_bp = 0 THEN 0
                ELSE (2 * v_attempt.amount_mnt * v_app.vat_rate_bp
                      + (10000 + v_app.vat_rate_bp))
                     / (2 * (10000 + v_app.vat_rate_bp))
           END;
  INSERT INTO platform.subscription_payment
    (hotel_id, subscription_id, purpose, provider, provider_payment_id, merchant_ref,
     gross_amount_mnt, vat_amount_mnt, provider_fee_mnt, net_amount_mnt, vat_rate_bp,
     package_code, term_months, monthly_price_mnt, discount_mnt,
     price_book_version, tax_config_version, package_feature_version,
     application_id, confirmed_at)
  VALUES (v_hotel_id, v_sub_id, 'ONBOARDING', v_attempt.provider, v_attempt.provider_payment_id,
          v_attempt.merchant_ref, v_attempt.amount_mnt, v_vat, 0, v_attempt.amount_mnt,
          v_app.vat_rate_bp, v_attempt.package_code, v_attempt.term_months,
          v_attempt.monthly_price_mnt, v_attempt.discount_mnt, v_attempt.price_book_version,
          v_attempt.tax_config_version, v_attempt.package_feature_version,
          v_app.application_id, v_attempt.confirmed_at)
  RETURNING payment_id INTO v_payment_id;

  INSERT INTO platform.subscription_event
    (hotel_id, subscription_id, event_type, billing_revision, to_package, to_expires_at,
     payment_id, actor_ref, detail)
  VALUES (v_hotel_id, v_sub_id, 'PROVISIONED', 1, v_attempt.package_code, v_expires_at,
          v_payment_id, 'onboarding',
          jsonb_build_object('applicationId', v_app.application_id::text));

  -- ---- the first Hotel Admin (doc 15 §5 steps 7 and 8)
  -- A proved existing active account keeps its own credential and is bound
  -- directly; otherwise an account is created with no credential at all, so it
  -- cannot sign in until the activation link has been redeemed.
  IF v_app.existing_account_id IS NOT NULL THEN
    v_account_id := v_app.existing_account_id;
  ELSE
    INSERT INTO platform.user_account (realm, email_normalized)
    VALUES ('hotel', v_app.admin_email_normalized)
    RETURNING account_id INTO v_account_id;
  END IF;

  INSERT INTO platform.staff_membership
    (hotel_id, account_id, invited_email_normalized, state, is_primary_admin,
     membership_revision, activated_at)
  VALUES (v_hotel_id, v_account_id, v_app.admin_email_normalized, 'ACTIVE', true, 1, now())
  RETURNING membership_id INTO v_membership;

  INSERT INTO platform.membership_role_grant (hotel_id, membership_id, role)
  VALUES (v_hotel_id, v_membership, 'HOTEL_ADMIN');

  -- The activation link and its sealed delivery are created here, with the
  -- tenant, or not at all. The plaintext token never reaches the database: the
  -- caller minted it, digested it and sealed it, and hands in only the digest
  -- and the ciphertext. A proved existing account gets neither — `ONB-DEC-003`
  -- forbids minting a second credential artefact for an account that has one.
  IF v_app.existing_account_id IS NULL THEN
    IF p_token_hash IS NULL OR p_token_key_version IS NULL OR p_token_expires_at IS NULL
       OR p_secret_ciphertext IS NULL OR p_secret_wrapped_dek IS NULL
       OR p_secret_key_version IS NULL THEN
      RAISE EXCEPTION 'a new Hotel Admin needs a sealed activation link'
        USING ERRCODE = '22023';
    END IF;
  ELSIF p_token_hash IS NOT NULL OR p_secret_ciphertext IS NOT NULL THEN
    RAISE EXCEPTION 'a proved existing account is never issued an activation link (ONB-DEC-003)'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO platform.hotel_admin_activation
    (activation_id, hotel_id, membership_id, account_id, application_id, state,
     email_normalized, token_hash, token_key_version, expires_at, activated_at)
  VALUES (coalesce(p_activation_id, gen_random_uuid()),
          v_hotel_id, v_membership, v_account_id, v_app.application_id,
          CASE WHEN v_app.existing_account_id IS NULL
               THEN 'PENDING_ACTIVATION' ELSE 'ACTIVE' END,
          v_app.admin_email_normalized,
          p_token_hash, p_token_key_version, p_token_expires_at,
          CASE WHEN v_app.existing_account_id IS NULL THEN NULL ELSE now() END)
  RETURNING activation_id INTO v_activation;

  IF v_app.existing_account_id IS NULL THEN
    INSERT INTO platform.activation_delivery
      (hotel_id, activation_id, email_normalized, secret_ciphertext, secret_wrapped_dek,
       secret_key_version, expires_at)
    VALUES (v_hotel_id, v_activation, v_app.admin_email_normalized, p_secret_ciphertext,
            p_secret_wrapped_dek, p_secret_key_version, p_token_expires_at);
  END IF;

  -- ---- the default drawer (doc 24 §2.1)
  INSERT INTO platform.cash_location (hotel_id, kind, name, code, is_default_drawer)
  VALUES (v_hotel_id, 'DRAWER', 'Үндсэн касс', 'MAIN', true);

  -- ---- the application, now provisioned
  UPDATE platform.onboarding_application
     SET state = 'PROVISIONED',
         provisioned_hotel_id = v_hotel_id,
         state_changed_at = now(),
         state_reason = 'provisioned',
         revision = revision + 1
   WHERE application_id = v_app.application_id;

  INSERT INTO platform.onboarding_event
    (application_id, from_state, to_state, reason, actor_ref, detail)
  VALUES (v_app.application_id, 'PROVISIONING', 'PROVISIONED', p_idempotency_key,
          session_user,
          jsonb_build_object('hotelId', v_hotel_id::text,
                             'subscriptionId', v_sub_id::text,
                             'membershipId', v_membership::text,
                             'activationId', v_activation::text));

  PERFORM audit.append_platform_audit_event(
    'onboarding.hotel.provisioned',
    'allowed',
    'hotel',
    v_hotel_id::text,
    NULL,
    jsonb_build_object(
      'applicationId', v_app.application_id::text,
      'subscriptionId', v_sub_id::text,
      'membershipId', v_membership::text,
      'paymentId', v_payment_id::text,
      'issuedBy', session_user
    )
  );

  PERFORM set_config('app.hotel_id', coalesce(v_prev_hotel, ''), true);
  PERFORM set_config('app.onboarding_ref', coalesce(v_prev_ref, ''), true);

  RETURN v_hotel_id;
END;
$$;
--> statement-breakpoint

-- `OPS-DEC-006`: calendar-month arithmetic in the hotel's own timezone, with the
-- last-day clamp. Written in SQL as well as in `@prsystem/time` because the
-- provisioning function computes the expiry itself and must not depend on a
-- value the caller passed in.
CREATE OR REPLACE FUNCTION platform.add_service_months(
  p_anchor timestamptz,
  p_months integer,
  p_timezone text
) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  SET search_path = pg_catalog
  AS $$
  -- date_trunc to the month, add the months, then clamp the day: `+ interval
  -- '1 month'` on 31 January already clamps in PostgreSQL, but doing it from the
  -- first of the month and re-adding the day makes the clamp explicit and
  -- keeps the time of day exactly as it was.
  SELECT (
    (
      least(
        date_part('day', p_anchor AT TIME ZONE p_timezone),
        date_part('day',
          (date_trunc('month', (p_anchor AT TIME ZONE p_timezone))
             + make_interval(months => p_months + 1) - make_interval(days => 1)))
      )::integer - 1
    ) * interval '1 day'
    + date_trunc('month', (p_anchor AT TIME ZONE p_timezone))
      + make_interval(months => p_months)
    + ((p_anchor AT TIME ZONE p_timezone)
       - date_trunc('day', (p_anchor AT TIME ZONE p_timezone)))
  ) AT TIME ZONE p_timezone
$$;
--> statement-breakpoint

ALTER FUNCTION platform.add_service_months(timestamptz, integer, text)
  OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER FUNCTION
  platform.provision_paid_hotel(uuid, text, uuid, text, text, timestamptz, bytea, bytea, text)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION
  platform.provision_paid_hotel(uuid, text, uuid, text, text, timestamptz, bytea, bytea, text)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  platform.provision_paid_hotel(uuid, text, uuid, text, text, timestamptz, bytea, bytea, text)
  TO prsystem_api;
--> statement-breakpoint

-- Exactly what the wrapper's body writes, and nothing else. These privileges
-- belong to a NOLOGIN group role no runtime holds and nobody can connect as;
-- the only way to exercise them is to call the function, which refuses anything
-- that is not a paid, owner-resolved, provisioning-ready application.
GRANT SELECT, UPDATE ON platform.onboarding_application TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT ON platform.onboarding_payment_attempt, platform.onboarding_owner_proof,
                platform.hotel_owner_link, platform.hotel_subscription,
                platform.activation_delivery, platform.ebarimt_issuance,
                platform.subscription_owner
  TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT INSERT ON platform.onboarding_event TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT INSERT ON platform.hotel, platform.hotel_profile, platform.hotel_owner_link,
                platform.hotel_subscription, platform.subscription_payment,
                platform.subscription_event, platform.user_account,
                platform.staff_membership, platform.membership_role_grant,
                platform.hotel_admin_activation, platform.activation_delivery,
                platform.cash_location
  TO prsystem_maintenance_fn;
--> statement-breakpoint
-- `INSERT ... RETURNING` needs SELECT as well: the wrapper threads the ids it
-- creates through the graph it is building. The rows are still confined by the
-- tenant policy — the scope it bound is the hotel it just minted — so this
-- reaches exactly the rows the same statement created.
GRANT SELECT ON platform.subscription_payment, platform.staff_membership,
                platform.hotel_admin_activation, platform.user_account
  TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.current_onboarding_ref(), platform.package_rank(text),
  platform.add_service_months(timestamptz, integer, text), platform.current_account_id(),
  platform.contains_denied_key(jsonb), platform.is_denied_key(text),
  platform.denied_payload_keys(), platform.current_hotel_id(),
  platform.staff_membership_guard(), platform.membership_role_grant_guard(),
  platform.hotel_admin_activation_guard(), platform.cash_location_guard(),
  platform.hotel_profile_guard(), platform.hotel_subscription_guard(),
  platform.onboarding_application_guard(), platform.activation_delivery_guard()
  TO prsystem_maintenance_fn;
--> statement-breakpoint

-- =====================================================================
-- Cross-tenant queue discovery
-- =====================================================================

-- Three background operations have to find work before they can scope to it:
-- the service-month boundary that applies a paid pending upgrade, the activation
-- delivery drain and the eBarimt issuance queue. Every row they look for is
-- tenant-scoped, so an unscoped scan sees nothing — correctly.
--
-- The answer is *not* a policy that lets the worker read every hotel's
-- subscriptions. These wrappers return identifiers and nothing else: no package,
-- no amount, no name, no email. The worker then opens one tenant-scoped
-- transaction per item, where the ordinary policy applies, the row is locked and
-- re-read, and the claim is a compare-and-set. Discovery is advisory; the claim
-- is the gate.
-- The one lookup an applicant makes before they have a scope.
--
-- Resolving a bearer reference to its application is a chicken-and-egg: the
-- policy needs `app.onboarding_ref`, and the reference is what the caller is
-- presenting. So the digest is resolved through this wrapper, which returns the
-- application id and nothing else — no state, no amount, no email, no owner. The
-- caller then establishes that scope and every subsequent statement goes through
-- the ordinary policy.
--
-- Presenting the correct digest is what entitles a caller to the scope, exactly
-- as presenting a session token is what entitles one to an account's. A wrong or
-- absent digest resolves to NULL and the caller reaches nothing.
-- The provider callback's own resolver.
--
-- A callback carries no applicant secret — it is a message from a payment
-- gateway, not from the applicant — so it cannot establish an onboarding scope
-- on its own, and the invoice reference it names is the only thing that
-- identifies the attempt. This resolves that reference to the application it
-- belongs to, and nothing else: no state, no amount, no owner.
--
-- The authority behind it is the gateway's signature verification, which the
-- service performs *before* calling this. The caller then establishes the
-- resolved scope and every subsequent statement — locking the attempt, locking
-- the application, applying the transition — goes through the ordinary policy.
CREATE OR REPLACE FUNCTION platform.resolve_payment_attempt(
  p_provider           text,
  p_provider_invoice_id text
) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.application_id
    FROM platform.onboarding_payment_attempt a
   WHERE a.provider = p_provider AND a.provider_invoice_id = p_provider_invoice_id
$$;
--> statement-breakpoint

ALTER FUNCTION platform.resolve_payment_attempt(text, text) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.resolve_payment_attempt(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.resolve_payment_attempt(text, text) TO prsystem_api;
--> statement-breakpoint

-- doc 15 §3.1: the existing-owner probe.
--
-- Duplicate detection has to answer one question — is this registration number
-- already an owner? — without letting an applicant *read* somebody else's owner
-- profile, because the profile holds the verified contact a proof would be sent
-- to. Handing that over would turn "prove you are the owner" into "tell us where
-- to ask".
--
-- So the probe returns an opaque reference, a **masked** destination, and
-- whether that owner already holds a hotel. Nothing else, and nothing
-- enumerable: a caller can only ever ask about the token their own application
-- carries, and the keyed HMAC means they cannot compute another one.
CREATE OR REPLACE FUNCTION platform.probe_subscription_owner(
  p_application_id uuid
) RETURNS TABLE (
  owner_id           uuid,
  masked_destination text,
  owns_other_hotel   boolean
)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT o.owner_id,
         CASE
           WHEN o.verified_email_normalized IS NOT NULL THEN
             -- One masking implementation, in the one place that produces a
             -- destination. `a****@example.test`.
             left(split_part(o.verified_email_normalized, '@', 1), 1)
               || repeat('*', greatest(1, length(split_part(o.verified_email_normalized, '@', 1)) - 1))
               || '@' || split_part(o.verified_email_normalized, '@', 2)
           WHEN o.verified_phone IS NOT NULL THEN
             repeat('*', greatest(1, length(o.verified_phone) - 2)) || right(o.verified_phone, 2)
           ELSE NULL
         END AS masked_destination,
         EXISTS (SELECT 1 FROM platform.hotel_owner_link l
                  WHERE l.owner_id = o.owner_id AND l.application_id <> a.application_id)
           AS owns_other_hotel
    FROM platform.onboarding_application a
    JOIN platform.subscription_owner o
      ON o.identity_type = a.owner_identity_type
     AND o.country_code = a.owner_country_code
     AND o.identifier_lookup_token = a.owner_identifier_lookup_token
   WHERE a.application_id = p_application_id
$$;
--> statement-breakpoint

-- The same question at callback time: has the owner this application is linked
-- to acquired a hotel through a different one? doc 15 §3.1's race.
CREATE OR REPLACE FUNCTION platform.owner_holds_other_hotel(p_application_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM platform.onboarding_application a
      JOIN platform.hotel_owner_link l ON l.owner_id = a.owner_id
     WHERE a.application_id = p_application_id
       AND l.application_id <> a.application_id
  )
$$;
--> statement-breakpoint

ALTER FUNCTION platform.probe_subscription_owner(uuid) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
ALTER FUNCTION platform.owner_holds_other_hotel(uuid) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.probe_subscription_owner(uuid),
                       platform.owner_holds_other_hotel(uuid)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.probe_subscription_owner(uuid),
                          platform.owner_holds_other_hotel(uuid)
  TO prsystem_api;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.resolve_onboarding_applicant(p_token_hash text)
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.application_id
    FROM platform.onboarding_application a
   WHERE a.applicant_token_hash = p_token_hash
$$;
--> statement-breakpoint

ALTER FUNCTION platform.resolve_onboarding_applicant(text) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.resolve_onboarding_applicant(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.resolve_onboarding_applicant(text) TO prsystem_api;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.due_upgrade_boundaries(p_limit integer)
  RETURNS TABLE (hotel_id uuid, subscription_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT s.hotel_id, s.subscription_id
    FROM platform.hotel_subscription s
   WHERE s.pending_upgrade_package IS NOT NULL
     AND s.pending_upgrade_effective_at <= pg_catalog.now()
   ORDER BY s.pending_upgrade_effective_at
   LIMIT greatest(1, least(coalesce(p_limit, 32), 512))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.pending_activation_deliveries(p_limit integer)
  RETURNS TABLE (hotel_id uuid, delivery_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT d.hotel_id, d.delivery_id
    FROM platform.activation_delivery d
   WHERE d.state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text])
     AND d.available_at <= pg_catalog.now()
     AND (d.claimed_until IS NULL OR d.claimed_until < pg_catalog.now())
   ORDER BY d.available_at, d.delivery_id
   LIMIT greatest(1, least(coalesce(p_limit, 32), 512))
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION platform.pending_ebarimt_issuances(p_limit integer)
  RETURNS TABLE (hotel_id uuid, issuance_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.hotel_id, e.issuance_id
    FROM platform.ebarimt_issuance e
   WHERE e.state = ANY (ARRAY['PENDING'::text, 'CLAIMED'::text])
     AND e.available_at <= pg_catalog.now()
     AND (e.claimed_until IS NULL OR e.claimed_until < pg_catalog.now())
   ORDER BY e.available_at, e.issuance_id
   LIMIT greatest(1, least(coalesce(p_limit, 32), 512))
$$;
--> statement-breakpoint

ALTER FUNCTION platform.due_upgrade_boundaries(integer) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
ALTER FUNCTION platform.pending_activation_deliveries(integer) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
ALTER FUNCTION platform.pending_ebarimt_issuances(integer) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.due_upgrade_boundaries(integer),
                       platform.pending_activation_deliveries(integer),
                       platform.pending_ebarimt_issuances(integer)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.due_upgrade_boundaries(integer),
                          platform.pending_activation_deliveries(integer),
                          platform.pending_ebarimt_issuances(integer)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint

-- =====================================================================
-- Row level security
-- =====================================================================

ALTER TABLE platform.subscription_owner            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_owner            FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.onboarding_application        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.onboarding_application        FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.onboarding_phone_verification ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.onboarding_phone_verification FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.onboarding_owner_proof        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.onboarding_owner_proof        FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.onboarding_payment_attempt    ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.onboarding_payment_attempt    FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.onboarding_event              ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.onboarding_event              FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_profile                 ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_profile                 FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_owner_link              ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_owner_link              FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_subscription            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_subscription            FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent   ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent   FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_payment          ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_payment          FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_event            ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.subscription_event            FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.ebarimt_issuance              ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.ebarimt_issuance              FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.cash_location                 ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.cash_location                 FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_admin_activation        ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.hotel_admin_activation        FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.activation_delivery           ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE platform.activation_delivery           FORCE ROW LEVEL SECURITY;
--> statement-breakpoint

-- ------------------------------------------------ pre-tenant policies
-- The applicant's own draft, and nothing else.
--
-- `app.onboarding_ref` is established from the bearer secret the application was
-- minted with, so an applicant reaches exactly one row. Unset it is NULL, and
-- `application_id = NULL` is never true — an anonymous statement with no
-- reference sees zero applications rather than everybody's.
CREATE POLICY applicant_scope ON platform.onboarding_application
  USING (application_id = platform.current_onboarding_ref())
  WITH CHECK (application_id = platform.current_onboarding_ref());
--> statement-breakpoint
-- doc 14: Operation reviews applications, retries failed provisioning and closes
-- reconciliation cases. That is a realm, not a tenant scope — and it is not a
-- widening of the applicant policy, because the two predicates are disjoint: an
-- applicant transaction is in the `hotel` realm and an Operation one has no
-- onboarding reference. Which Operation accounts may act is decided by the
-- named permissions above this layer, never by RLS alone.
CREATE POLICY operation_review ON platform.onboarding_application
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

CREATE POLICY applicant_scope ON platform.onboarding_phone_verification
  USING (application_id = platform.current_onboarding_ref())
  WITH CHECK (application_id = platform.current_onboarding_ref());
--> statement-breakpoint
CREATE POLICY operation_review ON platform.onboarding_phone_verification
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

CREATE POLICY applicant_scope ON platform.onboarding_owner_proof
  USING (application_id = platform.current_onboarding_ref())
  WITH CHECK (application_id = platform.current_onboarding_ref());
--> statement-breakpoint
CREATE POLICY operation_review ON platform.onboarding_owner_proof
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

CREATE POLICY applicant_scope ON platform.onboarding_payment_attempt
  USING (application_id = platform.current_onboarding_ref())
  WITH CHECK (application_id = platform.current_onboarding_ref());
--> statement-breakpoint
CREATE POLICY operation_review ON platform.onboarding_payment_attempt
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

CREATE POLICY applicant_scope ON platform.onboarding_event
  USING (application_id = platform.current_onboarding_ref())
  WITH CHECK (application_id = platform.current_onboarding_ref());
--> statement-breakpoint
CREATE POLICY operation_review ON platform.onboarding_event
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

-- An owner profile is reachable from the application it is bound to, and by
-- Operation. It is never enumerable: duplicate detection goes through the
-- lookup-token probe below, which answers about one token and returns an opaque
-- reference, so the registration-number space cannot be walked.
-- Creating an owner and reading one are different powers, so they are different
-- policies.
--
-- An applicant may **create** the owner profile their own registration number
-- resolves to — the identity triple must match the application they hold the
-- reference for, and the unique index means they can only succeed when no such
-- owner exists yet.
--
-- They may **read** only an owner their application is already linked to. That
-- is the asymmetry doc 15 §3.1 requires: an existing owner's profile holds the
-- verified contact a proof would be sent to, and an applicant who could read it
-- would learn where the challenge is going before proving anything. Duplicate
-- detection goes through the probe function instead, which answers with an
-- opaque reference and a masked destination.
CREATE POLICY applicant_create ON platform.subscription_owner
  FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM platform.onboarding_application a
                       WHERE a.application_id = platform.current_onboarding_ref()
                         AND a.owner_identity_type = subscription_owner.identity_type
                         AND a.owner_country_code = subscription_owner.country_code
                         AND a.owner_identifier_lookup_token
                             = subscription_owner.identifier_lookup_token));
--> statement-breakpoint
CREATE POLICY applicant_read ON platform.subscription_owner
  FOR SELECT
  USING (EXISTS (SELECT 1 FROM platform.onboarding_application a
                  WHERE a.application_id = platform.current_onboarding_ref()
                    AND a.owner_id = subscription_owner.owner_id));
--> statement-breakpoint
CREATE POLICY operation_review ON platform.subscription_owner
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

-- ------------------------------------- the definer's own read policy
-- Row level security applies to a `SECURITY DEFINER` function too: these tables
-- are `FORCE ROW LEVEL SECURITY` and the definer does not own them, so without
-- this the resolver wrappers above would look up a reference and find nothing —
-- which is precisely the scope they exist to establish.
--
-- `FOR SELECT` only, and only for `prsystem_maintenance_fn`: a NOLOGIN group
-- role no runtime holds and nobody can connect as, whose entire reachable
-- surface is the handful of wrappers it owns. It gains no INSERT, UPDATE or
-- DELETE reach from this — the provisioning wrapper's writes still have to
-- satisfy the ordinary tenant predicate, which is what proves every row it
-- creates belongs to the hotel it created.
CREATE POLICY resolver_read ON platform.onboarding_application
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY resolver_read ON platform.onboarding_payment_attempt
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY resolver_read ON platform.onboarding_owner_proof
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY resolver_read ON platform.subscription_owner
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY resolver_read ON platform.hotel_owner_link
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY resolver_read ON platform.hotel_subscription
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY resolver_read ON platform.activation_delivery
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY resolver_read ON platform.ebarimt_issuance
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint

-- ------------------------------------------------ tenant policies
CREATE POLICY tenant_isolation ON platform.hotel_profile
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_owner_link
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_subscription
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.subscription_billing_intent
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.subscription_payment
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.subscription_event
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.ebarimt_issuance
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.cash_location
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.hotel_admin_activation
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.activation_delivery
  USING (hotel_id = platform.current_hotel_id())
  WITH CHECK (hotel_id = platform.current_hotel_id());
--> statement-breakpoint

-- =====================================================================
-- Ownership and grants
-- =====================================================================

ALTER TABLE platform.subscription_owner            OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.onboarding_application        OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.onboarding_phone_verification OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.onboarding_owner_proof        OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.onboarding_payment_attempt    OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.onboarding_event              OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.hotel_profile                 OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.hotel_owner_link              OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.hotel_subscription            OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent   OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.subscription_payment          OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.subscription_event            OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.ebarimt_issuance              OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.cash_location                 OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.hotel_admin_activation        OWNER TO prsystem_migrate;
--> statement-breakpoint
ALTER TABLE platform.activation_delivery           OWNER TO prsystem_migrate;
--> statement-breakpoint

REVOKE ALL ON platform.subscription_owner, platform.onboarding_application,
              platform.onboarding_phone_verification, platform.onboarding_owner_proof,
              platform.onboarding_payment_attempt, platform.onboarding_event,
              platform.hotel_profile, platform.hotel_owner_link,
              platform.hotel_subscription, platform.subscription_billing_intent,
              platform.subscription_payment, platform.subscription_event,
              platform.ebarimt_issuance, platform.cash_location,
              platform.hotel_admin_activation, platform.activation_delivery
  FROM PUBLIC;
--> statement-breakpoint

-- The API owns the onboarding and billing code paths. Note what is *not* here:
-- no INSERT on `hotel_owner_link`, `hotel_subscription`, `subscription_payment`,
-- `subscription_event`, `hotel_profile`, `cash_location` or
-- `hotel_admin_activation`. Those rows exist only as the provisioning function's
-- output, so an unpaid caller has no statement that could create them
-- (`ONB-DEC-001`). No role holds DELETE anywhere in this migration.
GRANT SELECT, INSERT, UPDATE ON platform.subscription_owner TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.onboarding_application TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.onboarding_phone_verification TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.onboarding_owner_proof TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.onboarding_payment_attempt TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.onboarding_event TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE ON platform.hotel_profile TO prsystem_api;
--> statement-breakpoint
GRANT SELECT ON platform.hotel_owner_link TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE ON platform.hotel_subscription TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.subscription_billing_intent TO prsystem_api;
--> statement-breakpoint
-- Renewal and upgrade payments are recorded by the API inside the callback
-- transaction; the onboarding payment is written by the provisioning function.
-- INSERT only: `SUB-DEC-009` leaves no verb that could reverse one, and the
-- append-only trigger refuses UPDATE and DELETE outright.
GRANT SELECT, INSERT ON platform.subscription_payment TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.subscription_event TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON platform.ebarimt_issuance TO prsystem_api;
--> statement-breakpoint
GRANT SELECT ON platform.cash_location TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE ON platform.hotel_admin_activation TO prsystem_api;
--> statement-breakpoint
GRANT SELECT, UPDATE ON platform.activation_delivery TO prsystem_api;
--> statement-breakpoint

-- The worker runs the two scheduled Phase 05 operations: the service-month
-- boundary that applies a paid pending upgrade, and the eBarimt issuance queue.
-- It reads the subscription and updates only what those two operations touch.
GRANT SELECT, UPDATE ON platform.hotel_subscription TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.subscription_event TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.subscription_payment TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON platform.ebarimt_issuance TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON platform.activation_delivery TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, UPDATE ON platform.hotel_admin_activation TO prsystem_worker;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION platform.current_onboarding_ref()
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.package_rank(text)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.add_service_months(timestamptz, integer, text)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  platform.onboarding_application_guard(), platform.subscription_owner_guard(),
  platform.onboarding_payment_attempt_guard(), platform.hotel_subscription_guard(),
  platform.subscription_billing_intent_guard(), platform.ebarimt_issuance_guard(),
  platform.hotel_admin_activation_guard(), platform.activation_delivery_guard(),
  platform.cash_location_guard(), platform.hotel_profile_guard()
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint

-- ------------------------------------------------------------ internal gate
-- CLAUDE.md §9. Doc 15 §2.1 requires an OTP-verified phone, and no OTP provider
-- is contracted: CallPro is EXT-05 and is an SMS *send* contract, not an OTP
-- service, so assuming it would be inventing a capability nobody has approved.
-- The typed port and its deterministic simulator exist; the production adapter
-- does not, and this control records that it is closed.
INSERT INTO platform.internal_gate (control_code, description, blocker) VALUES
  ('INT-OTP-01', 'Phone one-time-password verification provider',
   'no OTP provider contracted; CallPro (EXT-05) is an SMS send contract, not an OTP service');
--> statement-breakpoint

-- ---------------------------------------------------- final privilege trim
-- CREATE on `platform` was needed only to transfer ownership of the wrapper.
-- The definer keeps USAGE, which its body needs to resolve the objects it
-- names, and loses the ability to create anything.
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
--> statement-breakpoint
