ALTER TABLE prsystem.guest_receipt DROP CONSTRAINT guest_receipt_channel_check;
ALTER TABLE prsystem.guest_receipt ADD CHECK (channel IN ('CASH','MANUAL_POS','QPAY','KHAAN'));
CREATE TABLE prsystem.guest_payment_intent (
    tenant_id text NOT NULL, stay_id text NOT NULL, id text NOT NULL,
    charge_id text NOT NULL, provider text NOT NULL CHECK (provider IN ('QPAY','KHAAN')),
    merchant_id text NOT NULL, amount_mnt bigint NOT NULL CHECK (amount_mnt>0),
    actor_id text NOT NULL, shift_id text NOT NULL, drawer_id text NOT NULL,
    recorded_at timestamptz NOT NULL, invoice_id text,
    state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','APPLIED')),
    last_provider_state text NOT NULL DEFAULT 'UNKNOWN' CHECK (last_provider_state IN ('UNKNOWN','PENDING','FAILED','EXPIRED','SUCCEEDED')),
    receipt_id text,
    PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,stay_id,charge_id) REFERENCES prsystem.guest_charge (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    FOREIGN KEY (tenant_id,shift_id) REFERENCES prsystem.reception_shift,
    FOREIGN KEY (tenant_id,drawer_id) REFERENCES prsystem.cash_drawer,
    CHECK ((state='PENDING' AND receipt_id IS NULL) OR (state='APPLIED' AND receipt_id IS NOT NULL AND last_provider_state='SUCCEEDED' AND invoice_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_guest_charge_payment ON prsystem.guest_payment_intent (tenant_id,charge_id) WHERE state='PENDING';
CREATE TABLE prsystem.guest_payment_evidence (
    tenant_id text NOT NULL, stay_id text NOT NULL, receipt_id text NOT NULL,
    provider text NOT NULL CHECK (provider IN ('MANUAL_POS','QPAY','KHAAN')),
    merchant_id text NOT NULL, payment_id text NOT NULL,
    amount_mnt bigint NOT NULL CHECK (amount_mnt>0), transacted_at timestamptz NOT NULL,
    terminal_id text, intent_id text,
    PRIMARY KEY (tenant_id,receipt_id), UNIQUE (provider,merchant_id,payment_id),
    FOREIGN KEY (tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,stay_id,intent_id) REFERENCES prsystem.guest_payment_intent (tenant_id,stay_id,id),
    CHECK ((provider='MANUAL_POS' AND terminal_id IS NOT NULL AND intent_id IS NULL)
        OR (provider<>'MANUAL_POS' AND terminal_id IS NULL AND intent_id IS NOT NULL))
);
ALTER TABLE prsystem.billing_capture DROP CONSTRAINT billing_capture_kind_check;
ALTER TABLE prsystem.billing_capture ADD CHECK (kind IN ('ONBOARDING','RENEWAL','GUEST'));
CREATE FUNCTION prsystem.claim_guest_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO prsystem.billing_capture VALUES (NEW.provider,NEW.merchant_id,NEW.payment_id,'GUEST',NEW.tenant_id||':'||NEW.receipt_id) ON CONFLICT DO NOTHING;
    IF NOT EXISTS (SELECT 1 FROM prsystem.billing_capture WHERE provider=NEW.provider AND merchant_id=NEW.merchant_id AND payment_id=NEW.payment_id AND kind='GUEST' AND reference_id=NEW.tenant_id||':'||NEW.receipt_id) THEN
        RAISE EXCEPTION 'Payment reference already used' USING ERRCODE='23505'; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER claim_guest_capture BEFORE INSERT ON prsystem.guest_payment_evidence
FOR EACH ROW EXECUTE FUNCTION prsystem.claim_guest_capture();
CREATE TRIGGER guest_payment_evidence_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_payment_evidence
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE FUNCTION prsystem.preserve_guest_payment_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable payment intent' USING ERRCODE='23514'; END IF;
    IF OLD.state='APPLIED' OR (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id)
        OR to_jsonb(NEW)-ARRAY['invoice_id','state','last_provider_state','receipt_id'] IS DISTINCT FROM
        to_jsonb(OLD)-ARRAY['invoice_id','state','last_provider_state','receipt_id'] THEN
        RAISE EXCEPTION 'Immutable payment intent' USING ERRCODE='23514'; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER guest_payment_intent_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_payment_intent
FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_guest_payment_intent();
REVOKE ALL ON prsystem.guest_payment_intent,prsystem.guest_payment_evidence FROM PUBLIC;
