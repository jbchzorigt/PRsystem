-- Explicit Platform-only operational work; immutable intent and delivery events.
ALTER TABLE prsystem.platform_session ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
ALTER TABLE prsystem.platform_session ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE TRIGGER platform_receipt_immutable BEFORE UPDATE OR DELETE ON prsystem.platform_receipt FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.operation_sms_draft (
 id text PRIMARY KEY,actor_id text NOT NULL REFERENCES prsystem.platform_account,
 filters jsonb NOT NULL,message text NOT NULL CHECK(length(btrim(message)) BETWEEN 1 AND 300),
 recipients jsonb NOT NULL,fingerprint text NOT NULL,quote jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL
);
CREATE TABLE prsystem.operation_sms_job (
 id text PRIMARY KEY,draft_id text NOT NULL UNIQUE REFERENCES prsystem.operation_sms_draft,
 actor_id text NOT NULL REFERENCES prsystem.platform_account,created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE prsystem.operation_sms_recipient (
 id text PRIMARY KEY,job_id text NOT NULL REFERENCES prsystem.operation_sms_job,
 phone text NOT NULL,tenant_ids jsonb NOT NULL,UNIQUE(job_id,phone)
);
CREATE TABLE prsystem.operation_sms_delivery (
 recipient_id text PRIMARY KEY REFERENCES prsystem.operation_sms_recipient,
 state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN('QUEUED','SENDING','UNKNOWN','SENT','DELIVERED','FAILED','CANCELLED')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 revision bigint NOT NULL DEFAULT 0,provider_id text,last_error_code text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE prsystem.operation_sms_event (
 id text PRIMARY KEY,recipient_id text NOT NULL REFERENCES prsystem.operation_sms_recipient,
 revision bigint NOT NULL,state text NOT NULL,details jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(recipient_id,revision)
);
CREATE FUNCTION prsystem.guard_operation_sms_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'QUEUED' OR NEW.attempts<>0 OR NEW.revision<>0 OR NEW.provider_id IS NOT NULL THEN RAISE EXCEPTION 'Invalid initial delivery' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.recipient_id<>OLD.recipient_id OR NEW.revision<>OLD.revision+1 OR
   NOT ((OLD.state='QUEUED' AND NEW.state IN('SENDING','CANCELLED')) OR
        (OLD.state='SENDING' AND NEW.state IN('SENT','DELIVERED','FAILED','UNKNOWN')) OR
        (OLD.state='UNKNOWN' AND NEW.state IN('SENT','DELIVERED','FAILED','UNKNOWN')) OR
        (OLD.state='SENT' AND NEW.state IN('SENT','DELIVERED','FAILED')) OR
        (OLD.state='FAILED' AND NEW.state='QUEUED')) OR
   NEW.attempts<>OLD.attempts+(CASE WHEN OLD.state='QUEUED' AND NEW.state='SENDING' THEN 1 ELSE 0 END)
  THEN RAISE EXCEPTION 'Invalid SMS transition' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER operation_sms_delivery_guard BEFORE INSERT OR UPDATE ON prsystem.operation_sms_delivery FOR EACH ROW EXECUTE FUNCTION prsystem.guard_operation_sms_delivery();
CREATE FUNCTION prsystem.prove_operation_sms_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.operation_sms_event e WHERE e.recipient_id=NEW.recipient_id AND e.revision=NEW.revision AND e.state=NEW.state)
 THEN RAISE EXCEPTION 'SMS delivery evidence required' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER operation_sms_delivery_proof AFTER INSERT OR UPDATE ON prsystem.operation_sms_delivery DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_operation_sms_delivery();
CREATE TABLE prsystem.operation_billing_job (
 id text PRIMARY KEY,actor_id text NOT NULL REFERENCES prsystem.platform_account,
 kind text NOT NULL CHECK(kind IN('PAYMENT_RECONCILE','EBARIMT')),
 source_kind text NOT NULL CHECK(source_kind IN('ONBOARDING','RENEWAL')),source_id text NOT NULL,snapshot jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE prsystem.operation_billing_result (
 job_id text PRIMARY KEY REFERENCES prsystem.operation_billing_job,state text NOT NULL CHECK(state IN('DONE','UNKNOWN','FAILED')),
 result jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['operation_sms_draft','operation_sms_job','operation_sms_recipient','operation_sms_event','operation_billing_job','operation_billing_result'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
REVOKE ALL ON prsystem.operation_sms_delivery FROM PUBLIC;
CREATE INDEX operation_sms_queue ON prsystem.operation_sms_delivery(state,updated_at,recipient_id);
CREATE INDEX operation_sms_job_page ON prsystem.operation_sms_job(created_at,id);
CREATE UNIQUE INDEX operation_billing_source ON prsystem.operation_billing_job(kind,source_kind,source_id);
ALTER TABLE prsystem.operation_billing_result DROP CONSTRAINT operation_billing_result_pkey;
ALTER TABLE prsystem.operation_billing_result ADD COLUMN attempt integer NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 5);
ALTER TABLE prsystem.operation_billing_result ADD PRIMARY KEY(job_id,attempt);
CREATE TABLE prsystem.operation_billing_retry (
 job_id text NOT NULL REFERENCES prsystem.operation_billing_job,attempt integer NOT NULL CHECK(attempt BETWEEN 1 AND 5),
 actor_id text NOT NULL REFERENCES prsystem.platform_account,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(job_id,attempt)
);
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.operation_billing_retry FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.operation_billing_retry FROM PUBLIC;
CREATE FUNCTION prsystem.guard_operation_sms_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.operation_sms_job j JOIN prsystem.operation_sms_draft d ON d.id=j.draft_id,
 jsonb_array_elements(d.recipients) r WHERE j.id=NEW.job_id AND r->>'phone'=NEW.phone AND r->'tenant_ids'=NEW.tenant_ids)
 THEN RAISE EXCEPTION 'Recipient must match reviewed canonical snapshot' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER operation_sms_recipient_guard BEFORE INSERT ON prsystem.operation_sms_recipient FOR EACH ROW EXECUTE FUNCTION prsystem.guard_operation_sms_recipient();
CREATE FUNCTION prsystem.guard_operation_sms_job() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.operation_sms_draft d JOIN prsystem.platform_account a ON a.id=d.actor_id
 WHERE d.id=NEW.draft_id AND d.actor_id=NEW.actor_id AND a.active AND 'SUBSCRIPTION_REMINDER_SEND'=ANY(a.permissions)
 AND d.expires_at>clock_timestamp() AND jsonb_array_length(d.recipients) BETWEEN 1 AND 100)
 THEN RAISE EXCEPTION 'Current reviewed sending authority required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER operation_sms_job_guard BEFORE INSERT ON prsystem.operation_sms_job FOR EACH ROW EXECUTE FUNCTION prsystem.guard_operation_sms_job();
