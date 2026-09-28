CREATE TABLE prsystem.booking_beneficiary(tenant_id text NOT NULL,revision bigint NOT NULL,reference text NOT NULL,actor_id text NOT NULL REFERENCES prsystem.platform_account(id),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,revision),FOREIGN KEY(tenant_id) REFERENCES prsystem.hotel_access);
CREATE TABLE prsystem.booking_settlement(tenant_id text NOT NULL,hold_id text NOT NULL,captured_mnt bigint NOT NULL,retained_mnt bigint NOT NULL,commission_mnt bigint NOT NULL,net_mnt bigint NOT NULL CHECK(net_mnt>=0),eligible_at timestamptz NOT NULL,batch_after timestamptz NOT NULL,snapshot jsonb NOT NULL,PRIMARY KEY(tenant_id,hold_id),FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_hold(tenant_id,id),CHECK(net_mnt+commission_mnt=retained_mnt),CHECK(captured_mnt>=retained_mnt AND retained_mnt>=0 AND commission_mnt>=0),CHECK(batch_after>eligible_at));
CREATE TABLE prsystem.booking_settlement_adjustment(tenant_id text NOT NULL,id text NOT NULL,hold_id text NOT NULL,amount_mnt bigint NOT NULL CHECK(amount_mnt<>0),target_net bigint NOT NULL CHECK(target_net>=0),source_hash text NOT NULL,snapshot jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,hold_id,source_hash),FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_settlement(tenant_id,hold_id));
CREATE TABLE prsystem.booking_finance_event(tenant_id text NOT NULL,id text NOT NULL,hold_id text NOT NULL,kind text NOT NULL,amount_mnt bigint NOT NULL,source_id text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,kind,source_id),FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_hold(tenant_id,id));
CREATE TABLE prsystem.booking_payout_batch(tenant_id text NOT NULL,id text NOT NULL,amount_mnt bigint NOT NULL CHECK(amount_mnt>0),beneficiary_revision bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,beneficiary_revision) REFERENCES prsystem.booking_beneficiary(tenant_id,revision));
CREATE TABLE prsystem.booking_payout_line(tenant_id text NOT NULL,batch_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('BASE','ADJUSTMENT')),source_id text NOT NULL,hold_id text NOT NULL,amount_mnt bigint NOT NULL,expected_net bigint NOT NULL,PRIMARY KEY(tenant_id,batch_id,kind,source_id),FOREIGN KEY(tenant_id,batch_id) REFERENCES prsystem.booking_payout_batch(tenant_id,id),FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_settlement(tenant_id,hold_id));
CREATE TABLE prsystem.booking_payout_void(tenant_id text NOT NULL,batch_id text NOT NULL,actor_id text NOT NULL REFERENCES prsystem.platform_account(id),reason text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,batch_id),FOREIGN KEY(tenant_id,batch_id) REFERENCES prsystem.booking_payout_batch(tenant_id,id));
CREATE TABLE prsystem.booking_payout_attempt(tenant_id text NOT NULL,id text NOT NULL,batch_id text NOT NULL,sequence integer NOT NULL CHECK(sequence>0),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,batch_id,sequence),FOREIGN KEY(tenant_id,batch_id) REFERENCES prsystem.booking_payout_batch(tenant_id,id));
CREATE TABLE prsystem.booking_payout_result(tenant_id text NOT NULL,attempt_id text NOT NULL,batch_id text NOT NULL,state text NOT NULL CHECK(state IN ('SUCCEEDED','FAILED')),reference text NOT NULL UNIQUE,amount_mnt bigint NOT NULL CHECK(amount_mnt>0),confirmed_at timestamptz NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,attempt_id),FOREIGN KEY(tenant_id,attempt_id) REFERENCES prsystem.booking_payout_attempt(tenant_id,id),FOREIGN KEY(tenant_id,batch_id) REFERENCES prsystem.booking_payout_batch(tenant_id,id));
CREATE UNIQUE INDEX booking_payout_once ON prsystem.booking_payout_result(tenant_id,batch_id) WHERE state='SUCCEEDED';
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['booking_beneficiary','booking_settlement','booking_settlement_adjustment','booking_finance_event','booking_payout_batch','booking_payout_void','booking_payout_line','booking_payout_attempt','booking_payout_result'] LOOP
 EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
 EXECUTE format('CREATE TRIGGER finance_immutable BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
 EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
ALTER TABLE prsystem.booking_payout_attempt ADD UNIQUE(tenant_id,id,batch_id);
ALTER TABLE prsystem.booking_payout_result ADD FOREIGN KEY(tenant_id,attempt_id,batch_id) REFERENCES prsystem.booking_payout_attempt(tenant_id,id,batch_id);
ALTER TABLE prsystem.booking_payout_line ADD CHECK(kind<>'BASE' OR source_id=hold_id);
CREATE TABLE prsystem.booking_paid_source(tenant_id text NOT NULL,kind text NOT NULL,source_id text NOT NULL,batch_id text NOT NULL,PRIMARY KEY(tenant_id,kind,source_id),FOREIGN KEY(tenant_id,batch_id) REFERENCES prsystem.booking_payout_batch(tenant_id,id));
ALTER TABLE prsystem.booking_paid_source ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.booking_paid_source FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.booking_paid_source USING(tenant_id=current_setting('prsystem.tenant_id',true)) WITH CHECK(tenant_id=current_setting('prsystem.tenant_id',true));
REVOKE ALL ON prsystem.booking_paid_source FROM PUBLIC;
CREATE TRIGGER paid_source_immutable BEFORE UPDATE OR DELETE ON prsystem.booking_paid_source FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE FUNCTION prsystem.guard_booking_payout_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='SUCCEEDED' THEN
  IF EXISTS(SELECT 1 FROM prsystem.booking_payout_void WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.batch_id)
   OR NEW.amount_mnt IS DISTINCT FROM (SELECT sum(amount_mnt) FROM prsystem.booking_payout_line WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.batch_id)
  THEN RAISE EXCEPTION 'Invalid payout source' USING ERRCODE='23514'; END IF;
  INSERT INTO prsystem.booking_paid_source SELECT tenant_id,kind,source_id,batch_id FROM prsystem.booking_payout_line WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.batch_id;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER payout_source_once BEFORE INSERT ON prsystem.booking_payout_result FOR EACH ROW EXECUTE FUNCTION prsystem.guard_booking_payout_success();
