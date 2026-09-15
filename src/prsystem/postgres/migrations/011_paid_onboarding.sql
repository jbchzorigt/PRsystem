CREATE TABLE prsystem.onboarding_application (
    id text PRIMARY KEY,
    access_hash text NOT NULL UNIQUE,
    payload jsonb NOT NULL,
    email text NOT NULL,
    owner_identifier text NOT NULL,
    owner_kind text NOT NULL CHECK (owner_kind IN ('INDIVIDUAL','COMPANY')),
    package_mnt integer NOT NULL CHECK (package_mnt IN (20000,25000,30000)),
    months integer NOT NULL CHECK (months IN (1,3,7,12)),
    phone_challenge text,
    phone_verified_at timestamptz,
    proof_account_id text REFERENCES prsystem.staff_account,
    state text NOT NULL DEFAULT 'DRAFT' CHECK (state IN ('DRAFT','OWNER_VERIFICATION_REQUIRED','PENDING_PAYMENT','PAYMENT_UNCERTAIN','PAYMENT_FAILED','PAYMENT_EXPIRED','PAID_OWNER_VERIFICATION_REQUIRED','PAID_PENDING_PROVISIONING','PROVISIONING_FAILED','PROVISIONED')),
    paid_attempt_id text,
    tenant_id text UNIQUE REFERENCES prsystem.hotel_access,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE prsystem.onboarding_attempt (
    id text PRIMARY KEY,
    application_id text NOT NULL REFERENCES prsystem.onboarding_application,
    provider text NOT NULL CHECK (provider IN ('QPAY','KHAAN')),
    merchant_id text NOT NULL,
    invoice_id text,
    amount bigint NOT NULL CHECK (amount>0),
    state text NOT NULL DEFAULT 'UNCERTAIN' CHECK (state IN ('PENDING','UNCERTAIN','FAILED','EXPIRED','PAID','RECONCILE','SUPERSEDED')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (provider,merchant_id,invoice_id)
);
CREATE UNIQUE INDEX one_active_onboarding_attempt ON prsystem.onboarding_attempt(application_id) WHERE state IN ('PENDING','UNCERTAIN');
ALTER TABLE prsystem.onboarding_application ADD FOREIGN KEY (paid_attempt_id) REFERENCES prsystem.onboarding_attempt;
CREATE TABLE prsystem.onboarding_payment (
    provider text NOT NULL,
    merchant_id text NOT NULL,
    payment_id text NOT NULL,
    attempt_id text NOT NULL REFERENCES prsystem.onboarding_attempt,
    amount bigint NOT NULL CHECK (amount>0),
    confirmed_at timestamptz NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (provider,merchant_id,payment_id),
    UNIQUE (attempt_id)
);
CREATE TRIGGER onboarding_payment_immutable BEFORE UPDATE OR DELETE ON prsystem.onboarding_payment
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.subscription_owner (
    id text PRIMARY KEY,
    kind text NOT NULL,
    identifier text NOT NULL,
    account_id text NOT NULL REFERENCES prsystem.staff_account,
    original_contact jsonb NOT NULL,
    UNIQUE (kind,identifier)
);
CREATE TABLE prsystem.hotel_subscription (
    tenant_id text PRIMARY KEY REFERENCES prsystem.hotel_access,
    owner_id text NOT NULL REFERENCES prsystem.subscription_owner,
    application_id text NOT NULL UNIQUE REFERENCES prsystem.onboarding_application,
    starts_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    package_floor integer NOT NULL CHECK (package_floor IN (20000,25000,30000)),
    listing_state text NOT NULL DEFAULT 'UNPUBLISHED' CHECK (listing_state IN ('UNPUBLISHED','REVIEW_REQUIRED'))
);
CREATE TABLE prsystem.onboarding_job (
    application_id text PRIMARY KEY REFERENCES prsystem.onboarding_application,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts>=0),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    last_error_code text
);
CREATE TABLE prsystem.onboarding_event (
    id text PRIMARY KEY,
    application_id text NOT NULL REFERENCES prsystem.onboarding_application,
    action text NOT NULL,
    details jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER onboarding_event_immutable BEFORE UPDATE OR DELETE ON prsystem.onboarding_event
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE FUNCTION prsystem.onboarding_snapshot_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.id,NEW.access_hash,NEW.payload,NEW.email,NEW.owner_identifier,NEW.owner_kind,NEW.package_mnt,NEW.months)
       IS DISTINCT FROM ROW(OLD.id,OLD.access_hash,OLD.payload,OLD.email,OLD.owner_identifier,OLD.owner_kind,OLD.package_mnt,OLD.months) THEN
       RAISE EXCEPTION 'Immutable application snapshot';
    END IF;
    IF OLD.paid_attempt_id IS NOT NULL AND NEW.paid_attempt_id IS DISTINCT FROM OLD.paid_attempt_id THEN
        RAISE EXCEPTION 'Immutable paid application';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER onboarding_snapshot_guard BEFORE UPDATE ON prsystem.onboarding_application
FOR EACH ROW EXECUTE FUNCTION prsystem.onboarding_snapshot_guard();
ALTER TABLE prsystem.staff_link DROP CONSTRAINT staff_link_purpose_check;
ALTER TABLE prsystem.staff_link DROP CONSTRAINT staff_link_scope_check;
ALTER TABLE prsystem.staff_link ADD CHECK (purpose IN ('INVITE','RESET','RESTAURANT_INVITE','ADMIN_ACTIVATION'));
ALTER TABLE prsystem.staff_link ADD CHECK (
    (purpose='INVITE' AND tenant_id IS NOT NULL AND inviter_id IS NOT NULL AND membership_revision IS NOT NULL AND restaurant_id IS NULL AND sponsor_tenant_id IS NULL)
 OR (purpose='RESET' AND tenant_id IS NULL AND inviter_id IS NULL AND membership_revision IS NULL AND restaurant_id IS NULL AND sponsor_tenant_id IS NULL)
 OR (purpose='RESTAURANT_INVITE' AND tenant_id IS NULL AND inviter_id IS NOT NULL AND membership_revision IS NOT NULL AND restaurant_id IS NOT NULL AND sponsor_tenant_id IS NOT NULL)
 OR (purpose='ADMIN_ACTIVATION' AND tenant_id IS NOT NULL AND inviter_id IS NULL AND membership_revision IS NOT NULL AND restaurant_id IS NULL AND sponsor_tenant_id IS NULL));
CREATE UNIQUE INDEX one_primary_activation ON prsystem.staff_link(tenant_id,account_id) WHERE purpose='ADMIN_ACTIVATION' AND state='ACTIVE';
REVOKE ALL ON prsystem.onboarding_application,prsystem.onboarding_attempt,prsystem.onboarding_payment,
 prsystem.subscription_owner,prsystem.hotel_subscription,prsystem.onboarding_job,prsystem.onboarding_event FROM PUBLIC;
