ALTER TABLE prsystem.guest_session ADD COLUMN id text NOT NULL DEFAULT md5(random()::text||clock_timestamp()::text);
CREATE UNIQUE INDEX guest_session_public_id ON prsystem.guest_session(tenant_id,stay_id,id);
CREATE TABLE prsystem.checkin_funding (
 tenant_id text NOT NULL,id text NOT NULL,room_id text NOT NULL,actor_id text NOT NULL,shift_id text NOT NULL,drawer_id text NOT NULL,
 channel text NOT NULL CHECK(channel IN ('MANUAL_POS','QPAY','KHAAN')),merchant_id text NOT NULL,
 amount_mnt bigint NOT NULL CHECK(amount_mnt BETWEEN 50000 AND 100000),mode text NOT NULL,
 setting_snapshot jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','CONFIRMED','APPLIED','CANCELLED')),
 invoice_id text,payment_id text,confirmed_at timestamptz,terminal_id text,
 stay_id text,receipt_id text,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY(tenant_id,shift_id) REFERENCES prsystem.reception_shift,
 FOREIGN KEY(tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt(tenant_id,stay_id,id),
 CHECK((channel='MANUAL_POS' AND terminal_id IS NOT NULL) OR(channel<>'MANUAL_POS' AND terminal_id IS NULL)),
 CHECK((state IN ('CONFIRMED','APPLIED') AND payment_id IS NOT NULL AND confirmed_at IS NOT NULL) OR state IN ('PENDING','CANCELLED')),
 CHECK((state='APPLIED' AND stay_id IS NOT NULL AND receipt_id IS NOT NULL) OR(state<>'APPLIED' AND stay_id IS NULL AND receipt_id IS NULL))
);
CREATE UNIQUE INDEX unique_checkin_payment ON prsystem.checkin_funding(channel,merchant_id,payment_id) WHERE payment_id IS NOT NULL;
ALTER TABLE prsystem.guest_payment_evidence ADD COLUMN funding_id text;
ALTER TABLE prsystem.guest_payment_evidence ADD FOREIGN KEY(tenant_id,funding_id) REFERENCES prsystem.checkin_funding;
ALTER TABLE prsystem.guest_payment_evidence DROP CONSTRAINT guest_payment_evidence_check;
ALTER TABLE prsystem.guest_payment_evidence ADD CHECK(
 (provider='MANUAL_POS' AND terminal_id IS NOT NULL AND intent_id IS NULL) OR
 (provider<>'MANUAL_POS' AND terminal_id IS NULL AND ((intent_id IS NOT NULL AND funding_id IS NULL) OR(intent_id IS NULL AND funding_id IS NOT NULL))));
CREATE FUNCTION prsystem.preserve_checkin_funding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable funding' USING ERRCODE='23514'; END IF;
 IF OLD.state IN ('APPLIED','CANCELLED') OR (to_jsonb(NEW)-ARRAY['state','invoice_id','payment_id','confirmed_at','stay_id','receipt_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['state','invoice_id','payment_id','confirmed_at','stay_id','receipt_id']) OR
 (OLD.payment_id IS NOT NULL AND (NEW.payment_id IS DISTINCT FROM OLD.payment_id OR NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at)) THEN
 RAISE EXCEPTION 'Immutable funding' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER checkin_funding_immutable BEFORE UPDATE OR DELETE ON prsystem.checkin_funding FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_checkin_funding();
REVOKE ALL ON prsystem.checkin_funding FROM PUBLIC;
