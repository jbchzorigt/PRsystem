-- 0005_onboarding_remediation2 — Phase 05 remediation 2: the correctness closure.
--
-- Forward-only, on top of 0004. Nothing here rewrites financial history: rows
-- gain states and nullable facts, functions gain a fence, the operator's two
-- decisions gain a policy that lets them commit with their authorization.
--
--  1. A quote or invoice is **prepared** before the provider is called and
--     **abandoned** when its finalization is refused: the original snapshot and
--     the provider's invoice are on the row either way, so a retry under the
--     same key recovers the same invoice at the same price and never re-prices
--     it, and an invoice the provider created for a quote that was never live
--     is tracked rather than lost (finding 1).
--  2. The provisioning boundary is fenced on the claim token and an unexpired
--     lease; the sweep discovers a lease that expired on the final automatic
--     attempt so it can be settled as exhausted (finding 3).
--  3. Receipt delivery is its own retryable job on the issuance row (finding 4).
--  4. The operator's reconciliation closure and receipt retry commit with the
--     authorization that permitted them, under the Operation realm (finding 5).
--  5. A provider fee is a fact the provider stated or a fact nobody has: NULL,
--     never a fabricated zero, and no net amount is derived from nothing
--     (finding 6).

-- The maintenance role owns the definers created here, exactly as in 0004: it
-- may create in the schema for the length of this migration and not after.
GRANT CREATE ON SCHEMA platform TO prsystem_maintenance_fn;
--> statement-breakpoint

-- =====================================================================
-- 1. Prepared and abandoned quotes and invoices
-- =====================================================================

ALTER TABLE platform.subscription_billing_intent
  ALTER COLUMN provider_invoice_id DROP NOT NULL,
  ALTER COLUMN provider_fee_mnt DROP NOT NULL,
  ALTER COLUMN provider_fee_mnt DROP DEFAULT,
  -- The complete subscription snapshot the price was computed from, written
  -- when the quote is prepared and compared, whole, at finalization.
  ADD COLUMN quoted_snapshot jsonb;
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent
  DROP CONSTRAINT subscription_billing_intent_state_known,
  DROP CONSTRAINT subscription_billing_intent_terminal_has_time;
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent
  ADD CONSTRAINT subscription_billing_intent_state_known
    CHECK (state = ANY (ARRAY['PREPARING'::text, 'PENDING'::text, 'PAID'::text,
                              'FAILED'::text, 'EXPIRED'::text, 'CANCELLED'::text,
                              'STALE'::text, 'ABANDONED'::text,
                              'PAID_REQUIRES_RECONCILIATION'::text])),
  ADD CONSTRAINT subscription_billing_intent_terminal_has_time
    CHECK ((state = ANY (ARRAY['PREPARING'::text, 'PENDING'::text])) = (terminal_at IS NULL)),
  -- Only a quote still waiting for the provider has no invoice.
  ADD CONSTRAINT subscription_billing_intent_invoice_once_live
    CHECK ((state = 'PREPARING'::text) OR (provider_invoice_id IS NOT NULL));
--> statement-breakpoint
-- One prepared row per merchant reference: the reference is derived from the
-- caller's idempotency key, so the same key can only ever recover this row.
CREATE UNIQUE INDEX subscription_billing_intent_merchant_ref_uq
  ON platform.subscription_billing_intent (merchant_ref);
--> statement-breakpoint

ALTER TABLE platform.onboarding_payment_attempt
  ALTER COLUMN provider_invoice_id DROP NOT NULL,
  ALTER COLUMN provider_fee_mnt DROP NOT NULL,
  ALTER COLUMN provider_fee_mnt DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE platform.onboarding_payment_attempt
  DROP CONSTRAINT onboarding_payment_attempt_state_known,
  DROP CONSTRAINT onboarding_payment_attempt_terminal_has_time;
--> statement-breakpoint
ALTER TABLE platform.onboarding_payment_attempt
  ADD CONSTRAINT onboarding_payment_attempt_state_known
    CHECK (state = ANY (ARRAY['PREPARING'::text, 'PENDING'::text, 'PAYMENT_UNCERTAIN'::text,
                              'PAID'::text, 'FAILED'::text, 'EXPIRED'::text, 'CANCELLED'::text,
                              'ABANDONED'::text, 'PAID_REQUIRES_RECONCILIATION'::text])),
  ADD CONSTRAINT onboarding_payment_attempt_terminal_has_time
    CHECK ((state = ANY (ARRAY['PREPARING'::text, 'PENDING'::text, 'PAYMENT_UNCERTAIN'::text]))
           = (terminal_at IS NULL)),
  ADD CONSTRAINT onboarding_payment_attempt_invoice_once_live
    CHECK ((state = 'PREPARING'::text) OR (provider_invoice_id IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX onboarding_payment_attempt_merchant_ref_uq
  ON platform.onboarding_payment_attempt (merchant_ref);
--> statement-breakpoint

-- The guards learn the two new edges and the one field that is written late:
-- the provider's invoice id, once, from NULL.
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
     OR (OLD.provider_invoice_id IS NOT NULL
         AND NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id)
     OR NEW.amount_mnt IS DISTINCT FROM OLD.amount_mnt
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.discount_mnt IS DISTINCT FROM OLD.discount_mnt
     OR NEW.quoted_billing_revision IS DISTINCT FROM OLD.quoted_billing_revision
     OR NEW.quoted_snapshot IS DISTINCT FROM OLD.quoted_snapshot
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
    -- Prepared: the provider answered, or its answer could not be used.
    WHEN 'PREPARING' THEN ARRAY['PENDING', 'ABANDONED']
    WHEN 'PENDING' THEN ARRAY['PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'STALE',
                              'PAID_REQUIRES_RECONCILIATION']
    -- A late capture on an intent that was superseded, abandoned, cancelled or
    -- expired is the reconciliation case of `LIFE-DEC-006`, never an entitlement.
    WHEN 'STALE' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
    WHEN 'ABANDONED' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
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
     OR (OLD.provider_invoice_id IS NOT NULL
         AND NEW.provider_invoice_id IS DISTINCT FROM OLD.provider_invoice_id)
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
    WHEN 'PREPARING' THEN ARRAY['PENDING', 'ABANDONED']
    WHEN 'PENDING' THEN ARRAY['PAYMENT_UNCERTAIN', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED',
                              'PAID_REQUIRES_RECONCILIATION']
    WHEN 'PAYMENT_UNCERTAIN' THEN ARRAY['PAID', 'FAILED', 'EXPIRED',
                                        'PAID_REQUIRES_RECONCILIATION']
    WHEN 'EXPIRED' THEN ARRAY['PAID', 'PAID_REQUIRES_RECONCILIATION']
    WHEN 'FAILED' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
    WHEN 'CANCELLED' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
    WHEN 'ABANDONED' THEN ARRAY['PAID_REQUIRES_RECONCILIATION']
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
-- 5. A fee the provider stated, or no fee at all
-- =====================================================================

ALTER TABLE platform.subscription_payment
  ALTER COLUMN provider_fee_mnt DROP NOT NULL,
  ALTER COLUMN provider_fee_mnt DROP DEFAULT,
  ALTER COLUMN net_amount_mnt DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE platform.subscription_payment
  DROP CONSTRAINT subscription_payment_net_is_gross_less_fee;
--> statement-breakpoint
ALTER TABLE platform.subscription_payment
  -- A net amount exists exactly when the fee it is derived from does.
  ADD CONSTRAINT subscription_payment_net_is_gross_less_fee
    CHECK ((provider_fee_mnt IS NULL AND net_amount_mnt IS NULL)
           OR (provider_fee_mnt IS NOT NULL
               AND net_amount_mnt = gross_amount_mnt - provider_fee_mnt));
--> statement-breakpoint

-- =====================================================================
-- 3. Receipt delivery as its own retryable job
-- =====================================================================

ALTER TABLE platform.ebarimt_issuance
  ADD COLUMN delivery_attempts     integer NOT NULL DEFAULT 0,
  ADD COLUMN delivery_available_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN delivery_claim_token  uuid,
  ADD COLUMN delivery_claimed_until timestamptz,
  ADD CONSTRAINT ebarimt_issuance_delivery_attempts_non_negative
    CHECK (delivery_attempts >= 0),
  ADD CONSTRAINT ebarimt_issuance_delivery_claim_complete
    CHECK (num_nonnulls(delivery_claim_token, delivery_claimed_until) = ANY (ARRAY[0, 2]));
--> statement-breakpoint
-- The deliveries that are due: issued receipts whose mail was never sent or
-- failed and is past its backoff, unclaimed or held by a process that died.
CREATE OR REPLACE FUNCTION platform.pending_ebarimt_deliveries(p_limit integer)
  RETURNS TABLE (hotel_id uuid, issuance_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT e.hotel_id, e.issuance_id
    FROM platform.ebarimt_issuance e
   WHERE e.state = 'ISSUED'
     AND e.delivery_state = ANY (ARRAY['PENDING'::text, 'FAILED'::text])
     AND e.delivery_available_at <= pg_catalog.now()
     AND (e.delivery_claimed_until IS NULL OR e.delivery_claimed_until < pg_catalog.now())
   ORDER BY e.delivery_available_at, e.issuance_id
   LIMIT greatest(1, least(coalesce(p_limit, 32), 512))
$$;
--> statement-breakpoint
ALTER FUNCTION platform.pending_ebarimt_deliveries(integer) OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.pending_ebarimt_deliveries(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.pending_ebarimt_deliveries(integer)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint

-- =====================================================================
-- 4. The operator's decisions commit with their authorization
-- =====================================================================

-- The two Operation actions on tenant rows — closing a reconciliation case and
-- reopening a receipt issuance — now run inside the transaction the Phase 04
-- pipeline authorized, which is the Operation realm's. The same policy the
-- onboarding tables carry: realm-gated, both directions.
CREATE POLICY operation_review ON platform.subscription_billing_intent
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint
CREATE POLICY operation_review ON platform.ebarimt_issuance
  USING (platform.current_realm() = 'operation'::text)
  WITH CHECK (platform.current_realm() = 'operation'::text);
--> statement-breakpoint

-- =====================================================================
-- 2. The fenced boundary and the exhausted lease
-- =====================================================================

-- A crash on the final automatic attempt leaves a PROVISIONING row whose lease
-- expired and whose attempt count is at the cap. The sweep must see it — to
-- settle it as exhausted — and must not attempt it again.
CREATE OR REPLACE FUNCTION platform.pending_provisioning_applications(
  p_limit        integer,
  p_max_attempts integer
) RETURNS TABLE (application_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT a.application_id
    FROM platform.onboarding_application a
   WHERE (
           (a.state = ANY (ARRAY['PAID_PENDING_PROVISIONING'::text, 'PROVISIONING_FAILED'::text])
            AND a.provision_attempts < greatest(1, coalesce(p_max_attempts, 5)))
           OR (a.state = 'PROVISIONING'::text
               AND a.provision_claim_token IS NOT NULL
               AND a.provision_claimed_until < pg_catalog.now())
           OR (a.state = 'PROVISIONED'::text AND a.provision_claim_token IS NOT NULL)
         )
     AND a.provision_available_at <= pg_catalog.now()
     AND (a.provision_claim_token IS NULL OR a.provision_claimed_until < pg_catalog.now())
   ORDER BY a.provision_available_at, a.application_id
   LIMIT greatest(1, least(coalesce(p_limit, 32), 512))
$$;
--> statement-breakpoint

DROP FUNCTION platform.provision_paid_hotel(uuid, text, uuid, bytea, bytea, text, uuid, text, text,
                                            timestamptz, bytea, bytea, text);
--> statement-breakpoint

-- The second edition's boundary, with one more parameter: the claim token the
-- caller holds. The row must be claimed by exactly that token and the lease
-- must not have expired — a worker whose lease lapsed, whose job another
-- worker has since taken, is refused here even though the row is PROVISIONING.
-- Everything else is the 0004 body, unchanged, except that the payment row
-- carries the fee the provider stated or no fee and no net amount at all.
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
  p_secret_key_version   text,
  -- The claim the caller holds. The row must be claimed by exactly this token
  -- with an unexpired lease (remediation 2, finding 3).
  p_claim_token          uuid
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

  -- The fence: this caller's claim, and a lease that is still live. A stale
  -- worker — lease expired, job reclaimed by another — is refused before it
  -- writes anything, however the row's state reads.
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'provisioning runs only under a claim' USING ERRCODE = '22023';
  END IF;
  IF v_app.provision_claim_token IS DISTINCT FROM p_claim_token
     OR v_app.provision_claimed_until IS NULL
     OR v_app.provision_claimed_until <= now() THEN
    RAISE EXCEPTION 'application % is not claimed by this worker, or its lease has expired',
      v_app.application_id USING ERRCODE = '42501';
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
          -- A net amount only from a fee the provider stated (remediation 2, finding 6).
          CASE WHEN v_attempt.provider_fee_mnt IS NULL THEN NULL
               ELSE v_attempt.amount_mnt - v_attempt.provider_fee_mnt END,
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
ALTER FUNCTION platform.provision_paid_hotel(uuid, text, uuid, bytea, bytea, text, uuid, text, text,
                                             timestamptz, bytea, bytea, text, uuid)
  OWNER TO prsystem_maintenance_fn;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.provision_paid_hotel(uuid, text, uuid, bytea, bytea, text, uuid,
                                                     text, text, timestamptz, bytea, bytea, text,
                                                     uuid)
  FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.provision_paid_hotel(uuid, text, uuid, bytea, bytea, text, uuid,
                                                        text, text, timestamptz, bytea, bytea, text,
                                                        uuid)
  TO prsystem_api, prsystem_worker;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA platform FROM prsystem_maintenance_fn;
