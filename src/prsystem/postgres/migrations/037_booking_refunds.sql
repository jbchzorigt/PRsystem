CREATE TABLE prsystem.booking_refund_request (
 tenant_id text NOT NULL,attempt_id text NOT NULL,hold_id text NOT NULL,id text NOT NULL UNIQUE,
 amount_mnt bigint NOT NULL CHECK(amount_mnt>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_provider_state text NOT NULL DEFAULT 'UNSENT',
 PRIMARY KEY(tenant_id,attempt_id),UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,hold_id,attempt_id) REFERENCES prsystem.booking_hold_attempt(tenant_id,hold_id,id),
 FOREIGN KEY(tenant_id,attempt_id) REFERENCES prsystem.booking_hold_capture(tenant_id,attempt_id)
);
CREATE TABLE prsystem.booking_refund_confirmation (
 tenant_id text NOT NULL,request_id text NOT NULL,provider text NOT NULL,merchant_id text NOT NULL,
 provider_reference text NOT NULL,amount_mnt bigint NOT NULL CHECK(amount_mnt>0),
 confirmed_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id),UNIQUE(provider,merchant_id,provider_reference),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.booking_refund_request(tenant_id,id)
);
CREATE FUNCTION prsystem.preserve_booking_refund_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR (to_jsonb(NEW)-'last_provider_state') IS DISTINCT FROM (to_jsonb(OLD)-'last_provider_state') THEN
 RAISE EXCEPTION 'Immutable booking refund source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER preserve_booking_refund_request BEFORE UPDATE OR DELETE ON prsystem.booking_refund_request FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_booking_refund_request();
CREATE TRIGGER booking_refund_confirmation_immutable BEFORE UPDATE OR DELETE ON prsystem.booking_refund_confirmation FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['booking_refund_request','booking_refund_confirmation'] LOOP
 EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
 EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
