-- Deposit receipt/allocation counters retain their existing meaning. Service
-- overpayment creates a separate refundable liability, net of reallocation.
ALTER TABLE prsystem.guest_finance ADD COLUMN service_credit bigint NOT NULL DEFAULT 0 CHECK(service_credit>=0);
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='prsystem.guest_finance'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%received%' AND pg_get_constraintdef(oid) LIKE '%refund_reserved%' LOOP
  EXECUTE format('ALTER TABLE prsystem.guest_finance DROP CONSTRAINT %I',c.conname);
 END LOOP;
END; $$;
ALTER TABLE prsystem.guest_finance ADD CONSTRAINT guest_refundable_liability_nonnegative
 CHECK(received::numeric+service_credit-reversed-allocated-refund_reserved-refunded>=0);
CREATE FUNCTION prsystem.prove_guest_service_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; actual bigint;
BEGIN
 SELECT coalesce(sum(x.amount_mnt),0) INTO expected FROM prsystem.minibar_paid_release x JOIN prsystem.guest_receipt r
 ON(r.tenant_id,r.id)=(x.tenant_id,x.receipt_id) WHERE x.tenant_id=NEW.tenant_id AND x.stay_id=NEW.stay_id AND r.purpose='PAYMENT';
 SELECT expected-coalesce(sum(x.amount_mnt),0) INTO expected FROM prsystem.minibar_paid_reallocation x JOIN prsystem.guest_receipt r
 ON(r.tenant_id,r.id)=(x.tenant_id,x.receipt_id) WHERE x.tenant_id=NEW.tenant_id AND x.stay_id=NEW.stay_id AND r.purpose='PAYMENT';
 SELECT service_credit INTO actual FROM prsystem.guest_finance WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Service credit requires linked payment release' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER service_credit_proof AFTER UPDATE ON prsystem.guest_finance
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.service_credit IS DISTINCT FROM OLD.service_credit)
 EXECUTE FUNCTION prsystem.prove_guest_service_credit();
CREATE CONSTRAINT TRIGGER service_credit_proof AFTER INSERT ON prsystem.minibar_paid_correction
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_guest_service_credit();
