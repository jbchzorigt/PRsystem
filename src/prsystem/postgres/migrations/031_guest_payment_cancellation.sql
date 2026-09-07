-- A pending mock invoice may release its obligation only after an authoritative
-- atomic void. Provider failures/expiry alone are not terminal evidence.
ALTER TABLE prsystem.guest_payment_intent DROP CONSTRAINT guest_payment_intent_state_check;
ALTER TABLE prsystem.guest_payment_intent ADD CHECK(state IN ('PENDING','APPLIED','CANCELLED'));
ALTER TABLE prsystem.guest_payment_intent DROP CONSTRAINT guest_payment_intent_last_provider_state_check;
ALTER TABLE prsystem.guest_payment_intent ADD CHECK(last_provider_state IN ('UNKNOWN','PENDING','FAILED','EXPIRED','SUCCEEDED','VOIDED'));
ALTER TABLE prsystem.guest_payment_intent DROP CONSTRAINT guest_payment_intent_check;
ALTER TABLE prsystem.guest_payment_intent ADD CHECK(
 (state='PENDING' AND receipt_id IS NULL) OR
 (state='APPLIED' AND receipt_id IS NOT NULL AND last_provider_state='SUCCEEDED' AND invoice_id IS NOT NULL) OR
 (state='CANCELLED' AND receipt_id IS NULL AND invoice_id IS NOT NULL AND last_provider_state='VOIDED'));
CREATE OR REPLACE FUNCTION prsystem.preserve_guest_payment_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable payment intent' USING ERRCODE='23514'; END IF;
 IF OLD.state<>'PENDING' OR (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id) OR (to_jsonb(NEW)-ARRAY['invoice_id','state','last_provider_state','receipt_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['invoice_id','state','last_provider_state','receipt_id']) THEN
 RAISE EXCEPTION 'Immutable payment intent' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
