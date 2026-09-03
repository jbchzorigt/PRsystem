-- =====================================================================
-- 0004 — Phase 05 remediation 1
-- =====================================================================
--
-- Forward-only. `0000`, `0001`, `0002` and `0003` are accepted or measured and
-- are not rewritten; every correction here is an ALTER, a replacement function
-- or a new one.
--
-- What changes, and the acceptance blocker each answers:
--
--   R2  the canonical owner is created inside the paid provisioning transaction,
--       never before payment; the existing-account proof is recorded with its
--       method and is revalidated inside the provisioning boundary; a definer
--       hands the *real* stored contact to the API process for the challenge
--       while the applicant still sees only a mask;
--   R3  the application is the durable provisioning job: a claim token, a
--       lease, an availability instant, an attempt count and a last error, plus
--       the discovery wrapper the worker sweeps with;
--   R4  the provisioning wrapper writes the outbox event and the eBarimt
--       issuance intent in the same transaction as the graph;
--   R8  a new Hotel Admin's account and Primary membership are pending until
--       the link is redeemed — a new account state, and a Primary membership
--       that may be `PENDING`;
--   R9  the provider fee is a column the provider's own status settles, so the
--       ledger's net amount is a fact rather than a hard-coded zero.

GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint

-- =====================================================================
-- R8 — pending accounts and pending Primary memberships
-- =====================================================================

-- doc 15 §5 step 7 and §7: a new user's account and first Hotel Admin
-- membership are `PENDING_ACTIVATION` until the activation link is redeemed.
-- The account carries the state itself: it has no credential, sign-in refuses
-- anything that is not `ACTIVE`, and the pipeline's stage 2 refuses it too.
ALTER TABLE platform.user_account DROP CONSTRAINT user_account_state_known;
--> statement-breakpoint
ALTER TABLE platform.user_account ADD CONSTRAINT user_account_state_known
  CHECK (state = ANY (ARRAY['PENDING_ACTIVATION'::text, 'ACTIVE'::text, 'SUSPENDED'::text,
                            'DISABLED'::text]));
--> statement-breakpoint

-- The Primary membership uses Phase 04's own pending state. `STAFF-DEC-006`'s
-- protection — a Primary is never suspended or terminated by a staff action —
-- is unchanged: the guard still refuses every move away from `ACTIVE`, and the
-- one move this permits is the activation's `PENDING → ACTIVE`.
ALTER TABLE platform.staff_membership DROP CONSTRAINT staff_membership_primary_is_active;
--> statement-breakpoint
ALTER TABLE platform.staff_membership ADD CONSTRAINT staff_membership_primary_is_active
  CHECK ((NOT is_primary_admin) OR (state = ANY (ARRAY['PENDING'::text, 'ACTIVE'::text])));
--> statement-breakpoint

-- =====================================================================
-- R3 / R2 / R9 — the application as the durable job, and the proof record
-- =====================================================================

ALTER TABLE platform.onboarding_application
  ADD COLUMN provision_available_at      timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN provision_claim_token       uuid,
  ADD COLUMN provision_claimed_until     timestamptz,
  ADD COLUMN provision_last_error        text,
  ADD COLUMN existing_account_proof_method text,
  ADD COLUMN existing_account_proved_at  timestamptz,
  ADD CONSTRAINT onboarding_application_claim_complete
    CHECK (num_nonnulls(provision_claim_token, provision_claimed_until) = ANY (ARRAY[0, 2])),
  -- doc 15 §3.1: an existing account is bound only with the proof that bound
  -- it — a signed-in session or a completed recovery — and when it was proved.
  ADD CONSTRAINT onboarding_application_account_proof_complete
    CHECK (num_nonnulls(existing_account_id, existing_account_proof_method,
                        existing_account_proved_at) = ANY (ARRAY[0, 3])),
  ADD CONSTRAINT onboarding_application_account_proof_method_known
    CHECK ((existing_account_proof_method IS NULL)
           OR (existing_account_proof_method
               = ANY (ARRAY['SIGNED_IN'::text, 'PASSWORD_RECOVERY'::text])));
--> statement-breakpoint

-- R9: the fee the provider retained, settled from the provider's own status
-- together with the payment id. Zero until then, and immutable afterwards.
ALTER TABLE platform.onboarding_payment_attempt
  ADD COLUMN provider_fee_mnt bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT onboarding_payment_attempt_fee_non_negative CHECK (provider_fee_mnt >= 0),
  ADD CONSTRAINT onboarding_payment_attempt_fee_within_amount
    CHECK (provider_fee_mnt <= amount_mnt);
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent
  ADD COLUMN provider_fee_mnt bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT subscription_billing_intent_fee_non_negative CHECK (provider_fee_mnt >= 0),
  ADD CONSTRAINT subscription_billing_intent_fee_within_amount
    CHECK (provider_fee_mnt <= amount_mnt);
--> statement-breakpoint

-- The application guard, with two additions: a bound existing account is
-- immutable once bound, and the §3.1 race may also be discovered at retry time
-- — an owner that appeared between two provisioning attempts sends the
-- application back to proof rather than letting a retry attach a hotel to
-- somebody else's profile.
CREATE OR REPLACE FUNCTION platform.onboarding_application_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'an onboarding application is evidence, not scratch space'
      USING ERRCODE = '42501';
  END IF;

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

  IF OLD.paid_attempt_id IS NOT NULL
     AND (NEW.paid_attempt_id IS DISTINCT FROM OLD.paid_attempt_id
          OR NEW.payment_confirmed_at IS DISTINCT FROM OLD.payment_confirmed_at) THEN
    RAISE EXCEPTION 'the confirmed payment of a paid application is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF OLD.owner_id IS NOT NULL AND NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'an application never moves to another owner' USING ERRCODE = '42501';
  END IF;
  IF OLD.existing_account_id IS NOT NULL
     AND (NEW.existing_account_id IS DISTINCT FROM OLD.existing_account_id
          OR NEW.existing_account_proof_method IS DISTINCT FROM OLD.existing_account_proof_method
          OR NEW.existing_account_proved_at IS DISTINCT FROM OLD.existing_account_proved_at) THEN
    RAISE EXCEPTION 'a proved existing account is never rebound' USING ERRCODE = '42501';
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
    WHEN 'PROVISIONING_FAILED' THEN ARRAY['PROVISIONING', 'PAID_OWNER_VERIFICATION_REQUIRED']
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

-- The attempt guard, with the fee joining the immutable settlement facts.
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
          OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
          OR NEW.provider_fee_mnt IS DISTINCT FROM OLD.provider_fee_mnt) THEN
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

-- =====================================================================
-- R2 — owners are provisioned, never pre-created
-- =====================================================================

-- The runtime loses INSERT on the owner profile: from here an owner comes into
-- existence only inside the provisioning wrapper, with the hotel it owns. The
-- applicant policy that permitted the pre-payment insert goes with it.
REVOKE INSERT ON platform.subscription_owner FROM prsystem_api;
--> statement-breakpoint
DROP POLICY applicant_create ON platform.subscription_owner;
--> statement-breakpoint
GRANT INSERT ON platform.subscription_owner TO prsystem_maintenance_fn;
--> statement-breakpoint
-- Row level security is forced on the table, so the definer needs its own
-- INSERT policy. It is the applicant policy's predicate, narrowed to the
-- provisioning role: the only owner the wrapper may create is the one whose
-- identifier the application being provisioned carries.
CREATE POLICY provisioner_create ON platform.subscription_owner
  FOR INSERT TO prsystem_maintenance_fn
  WITH CHECK (EXISTS (SELECT 1 FROM platform.onboarding_application a
                       WHERE a.application_id = platform.current_onboarding_ref()
                         AND a.owner_identity_type = subscription_owner.identity_type
                         AND a.owner_country_code = subscription_owner.country_code
                         AND a.owner_identifier_lookup_token
                             = subscription_owner.identifier_lookup_token));
--> statement-breakpoint

-- The definer reads the account table across tenants for two checks — an
-- account that already holds the applicant's email, and an account linked to
-- the owner through a Primary membership. Row level security applies to it, so
-- the same narrow read policy the other resolver wrappers have.
CREATE POLICY resolver_read ON platform.user_account
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint
CREATE POLICY resolver_read ON platform.staff_membership
  FOR SELECT TO prsystem_maintenance_fn USING (true);
--> statement-breakpoint

-- Whether an account already holds this application's admin email, as a
-- boolean and nothing else. The applicant's own scope cannot see accounts,
-- and must not: an account oracle is what this avoids being.
CREATE OR REPLACE FUNCTION platform.probe_existing_hotel_account(p_application_id uuid)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM platform.onboarding_application a
      JOIN platform.user_account u
        ON u.realm = 'hotel' AND u.email_normalized = a.admin_email_normalized
     WHERE a.application_id = p_application_id
  )
$$;
--> statement-breakpoint

-- doc 15 §3.1 proof (1): the signed-in account is the Primary Hotel Admin of a
-- hotel this owner already holds. Identifiers in, a boolean out.
CREATE OR REPLACE FUNCTION platform.account_linked_to_owner(
  p_application_id uuid,
  p_account_id     uuid
) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1
      FROM platform.onboarding_application a
      JOIN platform.hotel_owner_link l ON l.owner_id = a.owner_id
      JOIN platform.staff_membership m
        ON m.hotel_id = l.hotel_id AND m.account_id = p_account_id
       AND m.state = 'ACTIVE' AND m.is_primary_admin
     WHERE a.application_id = p_application_id
       AND l.application_id <> a.application_id
  )
$$;
--> statement-breakpoint

-- doc 15 §3.1 proof (2): the owner's *previously stored, verified* channel, in
-- full, for the API process to hand to the delivery port. The applicant never
-- sees this — `probe_subscription_owner` returns the mask — and the API holds
-- it only for the length of the delivery call.
CREATE OR REPLACE FUNCTION platform.owner_challenge_destination(p_application_id uuid)
  RETURNS TABLE (channel text, destination text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT CASE WHEN o.verified_phone IS NOT NULL THEN 'phone'
              WHEN o.verified_email_normalized IS NOT NULL THEN 'email'
              ELSE NULL END AS channel,
         coalesce(o.verified_phone, o.verified_email_normalized) AS destination
    FROM platform.onboarding_application a
    JOIN platform.subscription_owner o ON o.owner_id = a.owner_id
   WHERE a.application_id = p_application_id
$$;
--> statement-breakpoint

-- The masked probe now prefers the phone, which is the channel this flow
-- actually verifies at onboarding; the email is stored verified only once an
-- activation has proved it.
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
           WHEN o.verified_phone IS NOT NULL THEN
             repeat('*', greatest(1, length(o.verified_phone) - 2)) || right(o.verified_phone, 2)
           WHEN o.verified_email_normalized IS NOT NULL THEN
             left(split_part(o.verified_email_normalized, '@', 1), 1)
               || repeat('*', greatest(1, length(split_part(o.verified_email_normalized, '@', 1)) - 1))
               || '@' || split_part(o.verified_email_normalized, '@', 2)
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

-- =====================================================================
-- R3 — worker discovery, and the Operation queue read
-- =====================================================================

-- The provisioning work that is due: paid and unclaimed, failed and due for
-- another automatic attempt, claimed by a process that died (the lease
-- expired), or provisioned but never settled. Identifiers only; the worker
-- then locks and re-reads each row under the ordinary policy. The attempt cap
-- is the worker's parameter, so an exhausted application is invisible here and
-- reachable only through the permissioned manual retry.
CREATE OR REPLACE FUNCTION platform.pending_provisioning_applications(
  p_limit        integer,
  p_max_attempts integer
) RETURNS TABLE (application_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.application_id
    FROM platform.onboarding_application a
   WHERE (
           (a.state = ANY (ARRAY['PAID_PENDING_PROVISIONING'::text, 'PROVISIONING_FAILED'::text,
                                 'PROVISIONING'::text])
            AND a.provision_attempts < greatest(1, coalesce(p_max_attempts, 5)))
           OR (a.state = 'PROVISIONED'::text AND a.provision_claim_token IS NOT NULL)
         )
     AND a.provision_available_at <= pg_catalog.now()
     AND (a.provision_claim_token IS NULL OR a.provision_claimed_until < pg_catalog.now())
   ORDER BY a.provision_available_at, a.application_id
   LIMIT greatest(1, least(coalesce(p_limit, 32), 512))
$$;
--> statement-breakpoint

-- doc 16 §4.1 step 5: the receipts awaiting an operator, across every hotel.
-- Operation is a realm, not a tenant, so the tenant policy hides these rows
-- from it; the wrapper returns the identifiers and the error name, nothing
-- from the receipt or the payment.
CREATE OR REPLACE FUNCTION platform.manual_ebarimt_issuances(p_limit integer)
  RETURNS TABLE (hotel_id uuid, issuance_id uuid, payment_id uuid, last_error text,
                 created_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.hotel_id, e.issuance_id, e.payment_id, e.last_error, e.created_at
    FROM platform.ebarimt_issuance e
   WHERE e.state = 'MANUAL_RESOLUTION'
   ORDER BY e.created_at, e.issuance_id
   LIMIT greatest(1, least(coalesce(p_limit, 32), 512))
$$;
--> statement-breakpoint

-- =====================================================================
-- R2 / R4 / R8 / R9 — the provisioning boundary, second edition
-- =====================================================================

DROP FUNCTION platform.provision_paid_hotel(uuid, text, uuid, text, text, timestamptz, bytea,
                                            bytea, text);
--> statement-breakpoint

-- `ONB-DEC-001` and `ONB-DEC-006`: still the one way a hotel comes into
-- existence, and now also the one way an owner does. Everything the first
-- edition re-derived is still re-derived; what is added is
--
--   * the owner: created here when the application resolved to a new
--     registration number, from a ciphertext the caller resealed against the
--     owner id it minted (the AAD binds it), and refused outright if an owner
--     with that number appeared in the meantime — that is the §3.1 race, and
--     the caller sends the application back to proof;
--   * the account: a bound existing account is re-checked — realm, state,
--     email and the proof that bound it — and a new one is created only when no
--     account holds the email, in `PENDING_ACTIVATION` with no credential;
--   * the Primary membership: `PENDING` for a new account, `ACTIVE` for a
--     proved existing one (doc 15 §5 step 7);
--   * the eBarimt issuance intent and the `onboarding.hotel.provisioned`
--     outbox event, in this transaction, so the graph, the transition, the
--     delivery intent and the event commit together or not at all;
--   * the provider fee, so the ledger records what the provider actually
--     retained.
CREATE OR REPLACE FUNCTION platform.provision_paid_hotel(
  p_application_id       uuid,
  p_idempotency_key      text,
  -- The owner the caller minted and resealed the identifier against. NULL when
  -- the application already resolved to an existing owner.
  p_owner_id             uuid,
  p_owner_ciphertext     bytea,
  p_owner_wrapped_dek    bytea,
  p_owner_key_version    text,
  -- The activation the caller minted, digested and sealed (ADR-0020 §3).
  p_activation_id        uuid,
  p_token_hash           text,
  p_token_key_version    text,
  p_token_expires_at     timestamptz,
  p_secret_ciphertext    bytea,
  p_secret_wrapped_dek   bytea,
  p_secret_key_version   text
) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE
  v_app        platform.onboarding_application%ROWTYPE;
  v_attempt    platform.onboarding_payment_attempt%ROWTYPE;
  v_account    platform.user_account%ROWTYPE;
  v_hotel_id   uuid;
  v_owner_id   uuid;
  v_sub_id     uuid;
  v_membership uuid;
  v_account_id uuid;
  v_payment_id uuid;
  v_expires_at timestamptz;
  v_vat        bigint;
  v_activation uuid;
  v_proof      integer;
  v_new_account boolean;
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
  IF v_app.contact_phone_verified_at IS NULL THEN
    RAISE EXCEPTION 'provisioning needs a verified contact phone (doc 15 §2.1)'
      USING ERRCODE = '42501';
  END IF;

  -- ---- the account (doc 15 §3.1, §5.1), revalidated here rather than trusted
  IF v_app.existing_account_id IS NOT NULL THEN
    SELECT * INTO v_account FROM platform.user_account
      WHERE account_id = v_app.existing_account_id;
    IF NOT FOUND
       OR v_account.realm <> 'hotel'
       OR v_account.state <> 'ACTIVE'
       OR v_account.email_normalized <> v_app.admin_email_normalized
       OR v_app.existing_account_proved_at IS NULL
       OR v_app.existing_account_proof_method IS NULL THEN
      RAISE EXCEPTION 'the bound existing account is not a proved, active hotel account for this email'
        USING ERRCODE = '42501';
    END IF;
    v_new_account := false;
  ELSE
    IF EXISTS (SELECT 1 FROM platform.user_account u
                WHERE u.realm = 'hotel' AND u.email_normalized = v_app.admin_email_normalized) THEN
      RAISE EXCEPTION 'an account already holds this email; the existing-account proof is required (doc 15 §3.1)'
        USING ERRCODE = '42501';
    END IF;
    v_new_account := true;
  END IF;

  -- ---- the owner (doc 15 §3.1, §5 step 3, `ONB-DEC-005`)
  IF v_app.owner_id IS NULL THEN
    -- A new owner. Unless one with this registration number appeared since
    -- the pre-payment probe — the §3.1 race — in which case nothing here may
    -- attach the hotel to it: the caller sends the application back to proof.
    IF EXISTS (SELECT 1 FROM platform.subscription_owner o
                WHERE o.identity_type = v_app.owner_identity_type
                  AND o.country_code = v_app.owner_country_code
                  AND o.identifier_lookup_token = v_app.owner_identifier_lookup_token) THEN
      RAISE EXCEPTION 'an owner with this registration number now exists; ownership proof is required (ONB-DEC-007)'
        USING ERRCODE = 'P0501';
    END IF;
    IF p_owner_id IS NULL OR p_owner_ciphertext IS NULL OR p_owner_wrapped_dek IS NULL
       OR p_owner_key_version IS NULL THEN
      RAISE EXCEPTION 'a new owner needs a resealed identifier' USING ERRCODE = '22023';
    END IF;
    v_owner_id := p_owner_id;
  ELSE
    -- An existing owner: attached only behind a passed proof, whichever of
    -- §3.1's three methods produced it.
    SELECT count(*) INTO v_proof FROM platform.onboarding_owner_proof
      WHERE application_id = v_app.application_id AND state = 'PASSED';
    IF v_proof = 0 THEN
      RAISE EXCEPTION 'an existing owner requires a passed ownership proof (ONB-DEC-007)'
        USING ERRCODE = '42501';
    END IF;
    IF p_owner_id IS NOT NULL OR p_owner_ciphertext IS NOT NULL THEN
      RAISE EXCEPTION 'an existing owner is never re-created' USING ERRCODE = '42501';
    END IF;
    v_owner_id := v_app.owner_id;
  END IF;

  -- ---- the tenant
  --
  -- The definer is not exempt from row level security: the id is minted first
  -- and the scope bound to it, so the ordinary tenant policy proves every row
  -- created here belongs to the hotel created here.
  v_hotel_id := gen_random_uuid();
  PERFORM set_config('app.hotel_id', v_hotel_id::text, true);
  PERFORM set_config('app.onboarding_ref', v_app.application_id::text, true);

  IF v_app.owner_id IS NULL THEN
    INSERT INTO platform.subscription_owner
      (owner_id, owner_type, display_name, representative_name, representative_position,
       identity_type, country_code, identifier_ciphertext, identifier_wrapped_dek,
       identifier_key_version, identifier_lookup_token, identifier_lookup_key_version,
       verified_email_normalized, verified_phone)
    VALUES (v_owner_id, v_app.owner_type, v_app.owner_display_name, v_app.representative_name,
            v_app.representative_position, v_app.owner_identity_type, v_app.owner_country_code,
            p_owner_ciphertext, p_owner_wrapped_dek, p_owner_key_version,
            v_app.owner_identifier_lookup_token, v_app.owner_identifier_lookup_key_version,
            -- Only a channel this flow verified is stored: the phone was
            -- OTP-verified; the email is proved by activation, later.
            NULL, v_app.contact_phone);
  END IF;

  INSERT INTO platform.hotel (hotel_id, display_name)
  VALUES (v_hotel_id, v_app.hotel_display_name);

  INSERT INTO platform.hotel_profile
    (hotel_id, public_name, public_phone, district, khoroo, address_line,
     latitude_micro, longitude_micro, duplicate_review_required)
  VALUES (v_hotel_id, v_app.hotel_display_name, v_app.hotel_public_phone, v_app.district,
          v_app.khoroo, v_app.address_line, v_app.latitude_micro, v_app.longitude_micro,
          v_app.duplicate_review_required);

  INSERT INTO platform.hotel_owner_link (hotel_id, owner_id, owner_type, application_id)
  VALUES (v_hotel_id, v_owner_id, v_app.owner_type, v_app.application_id);

  -- ---- the subscription (`OPS-DEC-006`)
  v_expires_at := platform.add_service_months(
    v_attempt.confirmed_at, v_attempt.term_months, 'Asia/Ulaanbaatar');

  INSERT INTO platform.hotel_subscription
    (hotel_id, effective_package, package_floor, term_months, starts_at, expires_at)
  VALUES (v_hotel_id, v_attempt.package_code, v_attempt.package_code, v_attempt.term_months,
          v_attempt.confirmed_at, v_expires_at)
  RETURNING subscription_id INTO v_sub_id;

  -- ---- the money, immutable (doc 16 §4)
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
          v_attempt.merchant_ref, v_attempt.amount_mnt, v_vat, v_attempt.provider_fee_mnt,
          v_attempt.amount_mnt - v_attempt.provider_fee_mnt,
          v_app.vat_rate_bp, v_attempt.package_code, v_attempt.term_months,
          v_attempt.monthly_price_mnt, v_attempt.discount_mnt, v_attempt.price_book_version,
          v_attempt.tax_config_version, v_attempt.package_feature_version,
          v_app.application_id, v_attempt.confirmed_at)
  RETURNING payment_id INTO v_payment_id;

  -- `SUB-DEC-005`: one issuance intent per confirmed payment, with the payment.
  INSERT INTO platform.ebarimt_issuance (hotel_id, payment_id)
  VALUES (v_hotel_id, v_payment_id);

  INSERT INTO platform.subscription_event
    (hotel_id, subscription_id, event_type, billing_revision, to_package, to_expires_at,
     payment_id, actor_ref, detail)
  VALUES (v_hotel_id, v_sub_id, 'PROVISIONED', 1, v_attempt.package_code, v_expires_at,
          v_payment_id, 'onboarding',
          jsonb_build_object('applicationId', v_app.application_id::text));

  -- ---- the first Hotel Admin (doc 15 §5 steps 7 and 8; `ONB-DEC-003`)
  IF v_new_account THEN
    INSERT INTO platform.user_account (realm, email_normalized, state)
    VALUES ('hotel', v_app.admin_email_normalized, 'PENDING_ACTIVATION')
    RETURNING account_id INTO v_account_id;
  ELSE
    v_account_id := v_app.existing_account_id;
  END IF;

  INSERT INTO platform.staff_membership
    (hotel_id, account_id, invited_email_normalized, state, is_primary_admin,
     membership_revision, activated_at)
  VALUES (v_hotel_id, v_account_id, v_app.admin_email_normalized,
          CASE WHEN v_new_account THEN 'PENDING' ELSE 'ACTIVE' END,
          true, 1,
          CASE WHEN v_new_account THEN NULL ELSE now() END)
  RETURNING membership_id INTO v_membership;

  INSERT INTO platform.membership_role_grant (hotel_id, membership_id, role)
  VALUES (v_hotel_id, v_membership, 'HOTEL_ADMIN');

  IF v_new_account THEN
    IF p_token_hash IS NULL OR p_token_key_version IS NULL OR p_token_expires_at IS NULL
       OR p_secret_ciphertext IS NULL OR p_secret_wrapped_dek IS NULL
       OR p_secret_key_version IS NULL OR p_activation_id IS NULL THEN
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
          CASE WHEN v_new_account THEN 'PENDING_ACTIVATION' ELSE 'ACTIVE' END,
          v_app.admin_email_normalized,
          p_token_hash, p_token_key_version, p_token_expires_at,
          CASE WHEN v_new_account THEN NULL ELSE now() END)
  RETURNING activation_id INTO v_activation;

  IF v_new_account THEN
    INSERT INTO platform.activation_delivery
      (hotel_id, activation_id, email_normalized, secret_ciphertext, secret_wrapped_dek,
       secret_key_version, expires_at)
    VALUES (v_hotel_id, v_activation, v_app.admin_email_normalized, p_secret_ciphertext,
            p_secret_wrapped_dek, p_secret_key_version, p_token_expires_at);
  END IF;

  -- ---- the default drawer (doc 24 §2.1)
  INSERT INTO platform.cash_location (hotel_id, kind, name, code, is_default_drawer)
  VALUES (v_hotel_id, 'DRAWER', 'Үндсэн касс', 'MAIN', true);

  -- ---- the event, in this transaction (ADR-0010; doc 15 §5 step 8)
  INSERT INTO platform.outbox_event
    (hotel_id, aggregate_type, aggregate_id, event_type, event_version, payload,
     correlation_id, causation_id)
  VALUES (v_hotel_id, 'hotel', v_hotel_id::text, 'onboarding.hotel.provisioned', 1,
          jsonb_build_object('applicationId', v_app.application_id::text,
                             'activationRequired', v_new_account),
          nullif(current_setting('app.correlation_id', true), ''), NULL);

  -- ---- the application, now provisioned and its job settled
  UPDATE platform.onboarding_application
     SET state = 'PROVISIONED',
         owner_id = v_owner_id,
         provisioned_hotel_id = v_hotel_id,
         provision_claim_token = NULL,
         provision_claimed_until = NULL,
         provision_last_error = NULL,
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
                             'activationId', v_activation::text,
                             'newAccount', v_new_account));

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
      'newAccount', v_new_account,
      'issuedBy', session_user
    )
  );

  PERFORM set_config('app.hotel_id', coalesce(v_prev_hotel, ''), true);
  PERFORM set_config('app.onboarding_ref', coalesce(v_prev_ref, ''), true);

  RETURN v_hotel_id;
END;
$$;
--> statement-breakpoint

-- ---------------------------------------------------------- ownership
ALTER FUNCTION platform.provision_paid_hotel(uuid, text, uuid, bytea, bytea, text, uuid, text,
                                             text, timestamptz, bytea, bytea, text)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
ALTER FUNCTION platform.probe_existing_hotel_account(uuid) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
ALTER FUNCTION platform.account_linked_to_owner(uuid, uuid) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
ALTER FUNCTION platform.owner_challenge_destination(uuid) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
ALTER FUNCTION platform.pending_provisioning_applications(integer, integer)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
ALTER FUNCTION platform.manual_ebarimt_issuances(integer) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint

-- ---------------------------------------------------------- privileges
REVOKE ALL ON FUNCTION
  platform.provision_paid_hotel(uuid, text, uuid, bytea, bytea, text, uuid, text, text,
                                timestamptz, bytea, bytea, text),
  platform.probe_existing_hotel_account(uuid),
  platform.account_linked_to_owner(uuid, uuid),
  platform.owner_challenge_destination(uuid),
  platform.pending_provisioning_applications(integer, integer),
  platform.manual_ebarimt_issuances(integer)
  FROM PUBLIC;
--> statement-breakpoint
-- The provisioning boundary is held by both deployments: the API for the
-- permissioned manual retry, the worker for the durable job.
GRANT EXECUTE ON FUNCTION
  platform.provision_paid_hotel(uuid, text, uuid, bytea, bytea, text, uuid, text, text,
                                timestamptz, bytea, bytea, text),
  platform.probe_existing_hotel_account(uuid),
  platform.probe_subscription_owner(uuid)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION
  platform.account_linked_to_owner(uuid, uuid),
  platform.owner_challenge_destination(uuid),
  platform.manual_ebarimt_issuances(integer)
  TO prsystem_api;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.pending_provisioning_applications(integer, integer)
  TO prsystem_worker;
--> statement-breakpoint

-- The worker's own share of the pre-tenant graph: exactly what the job needs
-- to claim, run, settle and record. No INSERT on the application, no reach
-- into the owner beyond the probe.
GRANT SELECT, UPDATE ON platform.onboarding_application TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT ON platform.onboarding_payment_attempt TO prsystem_worker;
--> statement-breakpoint
-- The issuance worker names the buyer by the hotel's owner link.
GRANT SELECT ON platform.hotel_owner_link TO prsystem_worker;
--> statement-breakpoint
-- The §3.1 race can be discovered at claim time, so the worker may open the
-- proof it sends the application back to; it never decides one.
GRANT SELECT, INSERT, UPDATE ON platform.onboarding_owner_proof TO prsystem_worker;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.onboarding_event TO prsystem_worker;
--> statement-breakpoint
-- The wrapper writes the event and the issuance intent with the graph.
GRANT INSERT ON platform.outbox_event, platform.ebarimt_issuance TO prsystem_maintenance_fn;
--> statement-breakpoint
GRANT SELECT ON platform.outbox_event TO prsystem_maintenance_fn;
--> statement-breakpoint

-- ---------------------------------------------------- final privilege trim
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
--> statement-breakpoint
