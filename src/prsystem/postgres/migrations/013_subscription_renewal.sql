CREATE TABLE prsystem.subscription_renewal (
    id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES prsystem.hotel_subscription,
    actor_id text NOT NULL REFERENCES prsystem.staff_account,
    provider text NOT NULL CHECK (provider IN ('QPAY','KHAAN')),
    merchant_id text NOT NULL,
    invoice_id text,
    package_mnt integer NOT NULL CHECK (package_mnt IN (20000,25000,30000)),
    months integer NOT NULL CHECK (months IN (1,3,7,12)),
    amount bigint NOT NULL CHECK (amount>0),
    previous_expiry timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'UNCERTAIN' CHECK (state IN ('UNCERTAIN','PENDING','FAILED','EXPIRED','APPLIED','RECONCILE')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX one_active_renewal ON prsystem.subscription_renewal(tenant_id) WHERE state IN ('UNCERTAIN','PENDING');
CREATE TABLE prsystem.renewal_payment (
    provider text NOT NULL,
    merchant_id text NOT NULL,
    payment_id text NOT NULL,
    renewal_id text NOT NULL UNIQUE REFERENCES prsystem.subscription_renewal,
    confirmed_at timestamptz NOT NULL,
    amount bigint NOT NULL,
    PRIMARY KEY (provider,merchant_id,payment_id)
);
CREATE TRIGGER renewal_payment_immutable BEFORE UPDATE OR DELETE ON prsystem.renewal_payment
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.package_entitlement (
    renewal_id text PRIMARY KEY REFERENCES prsystem.subscription_renewal,
    tenant_id text NOT NULL REFERENCES prsystem.hotel_access,
    package_mnt integer NOT NULL CHECK (package_mnt IN (20000,25000,30000)),
    effective_at timestamptz NOT NULL,
    applied_at timestamptz
);
CREATE TABLE prsystem.billing_event (
    id text PRIMARY KEY,
    tenant_id text NOT NULL REFERENCES prsystem.hotel_access,
    action text NOT NULL,
    details jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER billing_event_immutable BEFORE UPDATE OR DELETE ON prsystem.billing_event
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.subscription_renewal,prsystem.renewal_payment,prsystem.package_entitlement,prsystem.billing_event FROM PUBLIC;
-- Shared capture uniqueness prevents one provider payment paying two products,
-- including concurrent onboarding and renewal workers in separate transactions.
CREATE TABLE prsystem.billing_capture (
    provider text NOT NULL,
    merchant_id text NOT NULL,
    payment_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('ONBOARDING','RENEWAL')),
    reference_id text NOT NULL,
    PRIMARY KEY (provider,merchant_id,payment_id)
);
INSERT INTO prsystem.billing_capture SELECT provider,merchant_id,payment_id,'ONBOARDING',attempt_id FROM prsystem.onboarding_payment;
INSERT INTO prsystem.billing_capture SELECT provider,merchant_id,payment_id,'RENEWAL',renewal_id FROM prsystem.renewal_payment;
CREATE FUNCTION prsystem.claim_billing_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME='onboarding_payment' THEN
        INSERT INTO prsystem.billing_capture VALUES (NEW.provider,NEW.merchant_id,NEW.payment_id,'ONBOARDING',NEW.attempt_id);
    ELSE
        INSERT INTO prsystem.billing_capture VALUES (NEW.provider,NEW.merchant_id,NEW.payment_id,'RENEWAL',NEW.renewal_id);
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER claim_onboarding_capture BEFORE INSERT ON prsystem.onboarding_payment
FOR EACH ROW EXECUTE FUNCTION prsystem.claim_billing_capture();
CREATE TRIGGER claim_renewal_capture BEFORE INSERT ON prsystem.renewal_payment
FOR EACH ROW EXECUTE FUNCTION prsystem.claim_billing_capture();
CREATE TRIGGER billing_capture_immutable BEFORE UPDATE OR DELETE ON prsystem.billing_capture
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.billing_capture FROM PUBLIC;
