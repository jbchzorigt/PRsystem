-- A confirmed pre-check-in payment already owns the provider capture even
-- before its guest receipt exists. It cannot fund another stay/payment meanwhile.
ALTER TABLE prsystem.billing_capture DROP CONSTRAINT billing_capture_kind_check;
ALTER TABLE prsystem.billing_capture ADD CHECK(kind IN ('ONBOARDING','RENEWAL','GUEST','FUNDING'));
CREATE FUNCTION prsystem.claim_checkin_funding_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.payment_id IS NULL THEN RETURN NEW; END IF;
 INSERT INTO prsystem.billing_capture VALUES(NEW.channel,NEW.merchant_id,NEW.payment_id,'FUNDING',NEW.tenant_id||':'||NEW.id) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM prsystem.billing_capture WHERE provider=NEW.channel AND merchant_id=NEW.merchant_id AND payment_id=NEW.payment_id
   AND ((kind='FUNDING' AND reference_id=NEW.tenant_id||':'||NEW.id) OR (NEW.state='APPLIED' AND kind='GUEST' AND reference_id=NEW.tenant_id||':'||NEW.receipt_id))) THEN
 RAISE EXCEPTION 'Funding capture already used' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER checkin_funding_capture AFTER INSERT OR UPDATE OF payment_id ON prsystem.checkin_funding FOR EACH ROW EXECUTE FUNCTION prsystem.claim_checkin_funding_capture();
INSERT INTO prsystem.billing_capture
 SELECT channel,merchant_id,payment_id,'FUNDING',tenant_id||':'||id FROM prsystem.checkin_funding WHERE payment_id IS NOT NULL ON CONFLICT DO NOTHING;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM prsystem.checkin_funding f JOIN prsystem.billing_capture c ON(c.provider,c.merchant_id,c.payment_id)=(f.channel,f.merchant_id,f.payment_id)
 WHERE NOT ((c.kind='FUNDING' AND c.reference_id=f.tenant_id||':'||f.id) OR(f.state='APPLIED' AND c.kind='GUEST' AND c.reference_id=f.tenant_id||':'||f.receipt_id))) THEN
 RAISE EXCEPTION 'Existing funding capture conflict requires reconciliation' USING ERRCODE='23505'; END IF;
END; $$;
CREATE OR REPLACE FUNCTION prsystem.claim_guest_capture() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.funding_id IS NOT NULL THEN
  IF NOT EXISTS(SELECT 1 FROM prsystem.checkin_funding f JOIN prsystem.billing_capture c ON(c.provider,c.merchant_id,c.payment_id)=(f.channel,f.merchant_id,f.payment_id)
    WHERE f.tenant_id=NEW.tenant_id AND f.id=NEW.funding_id AND f.state='CONFIRMED'
    AND f.channel=NEW.provider AND f.merchant_id=NEW.merchant_id AND f.payment_id=NEW.payment_id AND f.amount_mnt=NEW.amount_mnt
    AND c.kind='FUNDING' AND c.reference_id=f.tenant_id||':'||f.id) THEN
   RAISE EXCEPTION 'Funding capture does not own receipt' USING ERRCODE='23505'; END IF;
  RETURN NEW;
 END IF;
 INSERT INTO prsystem.billing_capture VALUES(NEW.provider,NEW.merchant_id,NEW.payment_id,'GUEST',NEW.tenant_id||':'||NEW.receipt_id) ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM prsystem.billing_capture WHERE provider=NEW.provider AND merchant_id=NEW.merchant_id AND payment_id=NEW.payment_id AND kind='GUEST' AND reference_id=NEW.tenant_id||':'||NEW.receipt_id) THEN
  RAISE EXCEPTION 'Payment reference already used' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END; $$;
