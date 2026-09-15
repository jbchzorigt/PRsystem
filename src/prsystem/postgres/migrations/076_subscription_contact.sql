-- Immutable contact versions; original onboarding contacts remain untouched.
CREATE TABLE prsystem.subscription_contact_change (
 tenant_id text NOT NULL,id text NOT NULL,actor_id text NOT NULL REFERENCES prsystem.staff_account,
 expected_revision bigint NOT NULL,old_phone text,new_phone text NOT NULL,email text NOT NULL,
 state text NOT NULL DEFAULT 'OPEN' CHECK(state IN('OPEN','APPLIED','CANCELLED')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id) REFERENCES prsystem.hotel_subscription
);
CREATE UNIQUE INDEX subscription_contact_open ON prsystem.subscription_contact_change(tenant_id) WHERE state='OPEN';
CREATE TABLE prsystem.subscription_contact_challenge (
 tenant_id text NOT NULL,request_id text NOT NULL,id text NOT NULL,side text NOT NULL CHECK(side IN('OLD','NEW')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.subscription_contact_change
);
CREATE TABLE prsystem.subscription_contact_verified (
 tenant_id text NOT NULL,challenge_id text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,challenge_id),FOREIGN KEY(tenant_id,challenge_id) REFERENCES prsystem.subscription_contact_challenge
);
CREATE TABLE prsystem.subscription_contact_exception (
 tenant_id text NOT NULL,request_id text NOT NULL,actor_id text NOT NULL REFERENCES prsystem.platform_account,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),reference text NOT NULL CHECK(length(btrim(reference)) BETWEEN 1 AND 200),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.subscription_contact_change
);
CREATE TABLE prsystem.subscription_contact (
 tenant_id text NOT NULL,revision bigint NOT NULL,phone text NOT NULL,request_id text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,revision),UNIQUE(tenant_id,request_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.subscription_contact_change
);
CREATE TABLE prsystem.subscription_contact_notice (
 tenant_id text NOT NULL,id text NOT NULL,request_id text NOT NULL,channel text NOT NULL CHECK(channel IN('EMAIL','SMS')),recipient text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id,channel),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.subscription_contact_change
);
CREATE TABLE prsystem.subscription_contact_notice_result (
 tenant_id text NOT NULL,notice_id text NOT NULL,provider_id text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,notice_id),FOREIGN KEY(tenant_id,notice_id) REFERENCES prsystem.subscription_contact_notice
);
CREATE FUNCTION prsystem.subscription_contact_phone(t text) RETURNS text LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT phone FROM prsystem.subscription_contact WHERE tenant_id=t ORDER BY revision DESC LIMIT 1),
 (SELECT o.original_contact->>'phone' FROM prsystem.hotel_subscription s JOIN prsystem.subscription_owner o ON o.id=s.owner_id WHERE s.tenant_id=t))
$$;
CREATE FUNCTION prsystem.guard_subscription_contact() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q prsystem.subscription_contact_change%ROWTYPE;proof_side text;
BEGIN
 SELECT * INTO q FROM prsystem.subscription_contact_change WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 IF NOT EXISTS(SELECT 1 FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id WHERE m.tenant_id=NEW.tenant_id AND m.account_id=q.actor_id AND m.is_primary AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.verified_at IS NOT NULL) OR q.state IS DISTINCT FROM 'OPEN' OR NEW.phone IS DISTINCT FROM q.new_phone OR NEW.revision<>q.expected_revision+1
 OR q.expected_revision<>coalesce((SELECT max(revision) FROM prsystem.subscription_contact WHERE tenant_id=NEW.tenant_id),0)
 THEN RAISE EXCEPTION 'Current contact intent required' USING ERRCODE='23514'; END IF;
 FOREACH proof_side IN ARRAY ARRAY['OLD','NEW'] LOOP
  IF proof_side='OLD' AND EXISTS(SELECT 1 FROM prsystem.subscription_contact_exception WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id) THEN CONTINUE; END IF;
  IF NOT EXISTS(SELECT 1 FROM prsystem.subscription_contact_challenge c JOIN prsystem.subscription_contact_verified v ON(v.tenant_id,v.challenge_id)=(c.tenant_id,c.id)
   WHERE c.tenant_id=NEW.tenant_id AND c.request_id=NEW.request_id AND c.side=proof_side AND c.expires_at>clock_timestamp()
   AND NOT EXISTS(SELECT 1 FROM prsystem.subscription_contact_challenge newer WHERE newer.tenant_id=c.tenant_id AND newer.request_id=c.request_id AND newer.side=c.side AND newer.created_at>c.created_at))
  THEN RAISE EXCEPTION 'Fresh phone proofs required' USING ERRCODE='23514'; END IF;
 END LOOP;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER subscription_contact_guard BEFORE INSERT ON prsystem.subscription_contact FOR EACH ROW EXECUTE FUNCTION prsystem.guard_subscription_contact();
CREATE FUNCTION prsystem.guard_subscription_contact_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.state<>'OPEN' OR NEW.state NOT IN('APPLIED','CANCELLED') OR (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
 OR(NEW.state='APPLIED' AND NOT EXISTS(SELECT 1 FROM prsystem.subscription_contact WHERE tenant_id=NEW.tenant_id AND request_id=NEW.id))
 THEN RAISE EXCEPTION 'Immutable contact intent' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER subscription_contact_change_guard BEFORE UPDATE OR DELETE ON prsystem.subscription_contact_change FOR EACH ROW EXECUTE FUNCTION prsystem.guard_subscription_contact_change();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['subscription_contact_change','subscription_contact_challenge','subscription_contact_verified','subscription_contact_exception','subscription_contact','subscription_contact_notice','subscription_contact_notice_result'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY contact_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true) OR EXISTS(SELECT 1 FROM prsystem.platform_account a WHERE a.id=current_setting(''prsystem.platform_id'',true) AND a.active AND a.permissions && ARRAY[''OPERATION_READ'',''SUBSCRIPTION_REMINDER_SEND'',''SUBSCRIPTION_CONTACT_CHANGE_APPROVE'']))',tab);
  IF tab<>'subscription_contact_change' THEN EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab); END IF;
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
CREATE FUNCTION prsystem.guard_contact_exception() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.platform_account WHERE id=NEW.actor_id AND active AND 'SUBSCRIPTION_CONTACT_CHANGE_APPROVE'=ANY(permissions))
 OR NOT EXISTS(SELECT 1 FROM prsystem.subscription_contact_change WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id AND state='OPEN')
 THEN RAISE EXCEPTION 'Explicit contact exception authority required' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER contact_exception_guard BEFORE INSERT ON prsystem.subscription_contact_exception FOR EACH ROW EXECUTE FUNCTION prsystem.guard_contact_exception();
CREATE FUNCTION prsystem.prove_contact_notices() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q prsystem.subscription_contact_change%ROWTYPE;
BEGIN
 SELECT * INTO q FROM prsystem.subscription_contact_change WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id;
 IF q.state<>'APPLIED' OR NOT EXISTS(SELECT 1 FROM prsystem.subscription_contact_notice WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id AND channel='EMAIL' AND recipient=q.email)
 OR (q.old_phone IS NOT NULL AND NOT EXISTS(SELECT 1 FROM prsystem.subscription_contact_notice WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id AND channel='SMS' AND recipient=q.old_phone))
 THEN RAISE EXCEPTION 'Old contact notifications must commit with contact change' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER contact_notice_proof AFTER INSERT ON prsystem.subscription_contact DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_contact_notices();
