-- Stage-four isolated mock booking boundary. No public booker identity is fabricated.
CREATE TABLE prsystem.booking_contract (
 tenant_id text NOT NULL REFERENCES prsystem.hotel_access, version bigint NOT NULL CHECK(version>0),
 contract_id text NOT NULL, rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
 valid_from timestamptz NOT NULL, valid_until timestamptz NOT NULL CHECK(valid_until>valid_from),
 actor_id text NOT NULL, mode text NOT NULL CHECK(mode='MOCK_ONLY'),
 PRIMARY KEY(tenant_id,version),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TABLE prsystem.booking_hold (
 tenant_id text NOT NULL, id text NOT NULL, category_id text NOT NULL, actor_id text NOT NULL,
 token_hash text NOT NULL UNIQUE, token_envelope jsonb NOT NULL,
 created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 planned_checkin_at timestamptz NOT NULL, planned_checkout_at timestamptz NOT NULL,
 cleaning_buffer_minutes integer NOT NULL CHECK(cleaning_buffer_minutes>=0),
 amount_mnt bigint NOT NULL CHECK(amount_mnt>0), snapshot jsonb NOT NULL,
 mode text NOT NULL DEFAULT 'MOCK_ONLY' CHECK(mode='MOCK_ONLY'),
 booking_state text NOT NULL DEFAULT 'HOLDING' CHECK(booking_state IN ('HOLDING','CONFIRMED','EXPIRED')),
 hold_state text NOT NULL DEFAULT 'ACTIVE' CHECK(hold_state IN ('ACTIVE','CONSUMED','EXPIRED')),
 applied_attempt_id text, confirmation_snapshot jsonb,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,category_id) REFERENCES prsystem.room_category(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 CHECK(expires_at=created_at+interval '10 minutes'),
 CHECK(planned_checkin_at>=created_at AND planned_checkout_at>planned_checkin_at),
 CHECK((booking_state='HOLDING' AND hold_state='ACTIVE' AND applied_attempt_id IS NULL AND confirmation_snapshot IS NULL)
 OR(booking_state='CONFIRMED' AND hold_state='CONSUMED' AND applied_attempt_id IS NOT NULL AND confirmation_snapshot IS NOT NULL)
 OR(booking_state='EXPIRED' AND hold_state='EXPIRED' AND applied_attempt_id IS NULL AND confirmation_snapshot IS NULL))
);
CREATE TABLE prsystem.booking_hold_attempt (
 tenant_id text NOT NULL, id text NOT NULL, hold_id text NOT NULL, provider text NOT NULL CHECK(provider IN ('QPAY','KHAAN')),
 merchant_id text NOT NULL, created_at timestamptz NOT NULL, invoice_expires_at timestamptz NOT NULL,
 invoice_id text, state text NOT NULL DEFAULT 'ACTIVE' CHECK(state IN ('ACTIVE','SUPERSEDED','PAID','EXPIRED')),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,hold_id,id),UNIQUE(provider,merchant_id,invoice_id),
 FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_hold(tenant_id,id),
 CHECK(invoice_expires_at>created_at)
);
ALTER TABLE prsystem.booking_hold ADD FOREIGN KEY(tenant_id,id,applied_attempt_id)
 REFERENCES prsystem.booking_hold_attempt(tenant_id,hold_id,id);
CREATE UNIQUE INDEX booking_one_active_attempt ON prsystem.booking_hold_attempt(tenant_id,hold_id) WHERE state='ACTIVE';
CREATE TABLE prsystem.booking_hold_capture (
 tenant_id text NOT NULL, attempt_id text NOT NULL, hold_id text NOT NULL,
 provider text NOT NULL, merchant_id text NOT NULL, payment_id text NOT NULL,
 amount_mnt bigint NOT NULL CHECK(amount_mnt>0), confirmed_at timestamptz NOT NULL,
 disposition text NOT NULL CHECK(disposition IN ('APPLIED','DUPLICATE_CAPTURE','LATE_PAYMENT_AFTER_HOLD','FULFILLMENT_UNAVAILABLE')),
 refund_due bigint NOT NULL CHECK(refund_due>=0 AND refund_due<=amount_mnt),
 PRIMARY KEY(tenant_id,attempt_id), UNIQUE(provider,merchant_id,payment_id),
 FOREIGN KEY(tenant_id,hold_id,attempt_id) REFERENCES prsystem.booking_hold_attempt(tenant_id,hold_id,id),
 CHECK((disposition='APPLIED' AND refund_due=0) OR(disposition<>'APPLIED' AND refund_due=amount_mnt))
);
CREATE TABLE prsystem.booking_hold_event (
 tenant_id text NOT NULL, id text NOT NULL, hold_id text NOT NULL,
 kind text NOT NULL, details jsonb NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_hold(tenant_id,id)
);
CREATE TABLE prsystem.booking_hold_command (
 tenant_id text NOT NULL,hold_id text NOT NULL,key text NOT NULL, command jsonb NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(tenant_id,hold_id,key),FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_hold(tenant_id,id)
);
ALTER TABLE prsystem.billing_capture DROP CONSTRAINT billing_capture_kind_check;
ALTER TABLE prsystem.billing_capture ADD CHECK(kind IN ('ONBOARDING','RENEWAL','GUEST','FUNDING','BOOKING'));
CREATE FUNCTION prsystem.preserve_booking_hold() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable booking hold' USING ERRCODE='23514'; END IF;
 IF OLD.booking_state<>'HOLDING' OR
 (to_jsonb(NEW)-ARRAY['booking_state','hold_state','applied_attempt_id','confirmation_snapshot']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['booking_state','hold_state','applied_attempt_id','confirmation_snapshot']) THEN
 RAISE EXCEPTION 'Immutable booking hold' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER preserve_booking_hold BEFORE UPDATE OR DELETE ON prsystem.booking_hold FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_booking_hold();
CREATE FUNCTION prsystem.preserve_booking_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable booking attempt' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['state','invoice_id']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','invoice_id'])
 OR (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id)
 OR (OLD.state='PAID' AND NEW.state<>'PAID') THEN
 RAISE EXCEPTION 'Immutable booking attempt' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER preserve_booking_attempt BEFORE UPDATE OR DELETE ON prsystem.booking_hold_attempt FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_booking_attempt();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['booking_contract','booking_hold','booking_hold_attempt','booking_hold_capture','booking_hold_event','booking_hold_command'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING (tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK (tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
 FOREACH tab IN ARRAY ARRAY['booking_contract','booking_hold_capture','booking_hold_event','booking_hold_command'] LOOP
  EXECUTE format('CREATE TRIGGER booking_history_immutable BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
 END LOOP;
END; $$;
