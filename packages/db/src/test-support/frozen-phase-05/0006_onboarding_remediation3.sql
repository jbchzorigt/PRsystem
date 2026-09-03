-- 0006_onboarding_remediation3 — Phase 05 remediation 3: a durable pre-invoice refusal.
--
-- Forward-only, on top of 0005. 0005 made a quote or invoice `PREPARING` before
-- the provider is called and `ABANDONED` when its finalization was refused,
-- and required every row that is not `PREPARING` to carry a provider invoice.
-- A provider that refuses to create the invoice at all — REJECTED or MISMATCH
-- — leaves a legitimate terminal row with no invoice, which that check
-- refused, and the stored refusal rolled back with it (finding 1).
--
-- `REFUSED` is that row: terminal, reached only from `PREPARING`, and the one
-- state besides `PREPARING` that may hold no invoice — it must hold none. Every
-- live, paid, stale, abandoned or reconciled row still requires its invoice.

ALTER TABLE platform.subscription_billing_intent
  DROP CONSTRAINT subscription_billing_intent_state_known,
  DROP CONSTRAINT subscription_billing_intent_invoice_once_live;
--> statement-breakpoint
ALTER TABLE platform.subscription_billing_intent
  ADD CONSTRAINT subscription_billing_intent_state_known
    CHECK (state = ANY (ARRAY['PREPARING'::text, 'PENDING'::text, 'PAID'::text,
                              'FAILED'::text, 'EXPIRED'::text, 'CANCELLED'::text,
                              'STALE'::text, 'ABANDONED'::text, 'REFUSED'::text,
                              'PAID_REQUIRES_RECONCILIATION'::text])),
  ADD CONSTRAINT subscription_billing_intent_invoice_once_live
    CHECK ((state = 'PREPARING'::text)
           OR ((state = 'REFUSED'::text) AND (provider_invoice_id IS NULL))
           OR ((state <> 'REFUSED'::text) AND (provider_invoice_id IS NOT NULL)));
--> statement-breakpoint

ALTER TABLE platform.onboarding_payment_attempt
  DROP CONSTRAINT onboarding_payment_attempt_state_known,
  DROP CONSTRAINT onboarding_payment_attempt_invoice_once_live;
--> statement-breakpoint
ALTER TABLE platform.onboarding_payment_attempt
  ADD CONSTRAINT onboarding_payment_attempt_state_known
    CHECK (state = ANY (ARRAY['PREPARING'::text, 'PENDING'::text, 'PAYMENT_UNCERTAIN'::text,
                              'PAID'::text, 'FAILED'::text, 'EXPIRED'::text, 'CANCELLED'::text,
                              'ABANDONED'::text, 'REFUSED'::text,
                              'PAID_REQUIRES_RECONCILIATION'::text])),
  ADD CONSTRAINT onboarding_payment_attempt_invoice_once_live
    CHECK ((state = 'PREPARING'::text)
           OR ((state = 'REFUSED'::text) AND (provider_invoice_id IS NULL))
           OR ((state <> 'REFUSED'::text) AND (provider_invoice_id IS NOT NULL)));
--> statement-breakpoint

-- The guards learn the one new edge. A refused row has no further edge: there
-- is no invoice a late capture could name.
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
    WHEN 'PREPARING' THEN ARRAY['PENDING', 'ABANDONED', 'REFUSED']
    WHEN 'PENDING' THEN ARRAY['PAID', 'FAILED', 'EXPIRED', 'CANCELLED', 'STALE',
                              'PAID_REQUIRES_RECONCILIATION']
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
    WHEN 'PREPARING' THEN ARRAY['PENDING', 'ABANDONED', 'REFUSED']
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
