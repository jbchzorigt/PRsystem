ALTER TABLE prsystem.booking_hold_cancellation DROP CONSTRAINT booking_hold_cancellation_outcome_check;
ALTER TABLE prsystem.booking_hold_cancellation ADD CHECK(outcome IN ('CANCELLED_GUEST','CANCELLED_HOTEL','NO_SHOW'));
ALTER TABLE prsystem.booking_hold_cancellation ALTER COLUMN attempt_id DROP NOT NULL;
ALTER TABLE prsystem.booking_hold_cancellation DROP CONSTRAINT booking_hold_cancellation_captured_mnt_check;
ALTER TABLE prsystem.booking_hold_cancellation ADD CHECK(captured_mnt>=0 AND ((captured_mnt=0 AND attempt_id IS NULL AND outcome='CANCELLED_GUEST') OR (captured_mnt>0 AND attempt_id IS NOT NULL)));
CREATE TABLE prsystem.booking_category_rank (
 tenant_id text NOT NULL,category_id text NOT NULL,rank integer NOT NULL CHECK(rank>=0),revision bigint NOT NULL CHECK(revision>0),
 PRIMARY KEY(tenant_id,category_id),FOREIGN KEY(tenant_id,category_id) REFERENCES prsystem.room_category(tenant_id,id)
);
CREATE TABLE prsystem.booking_upgrade (
 tenant_id text NOT NULL,hold_id text NOT NULL,id text NOT NULL,room_id text NOT NULL,actor_id text NOT NULL,
 source_rank integer NOT NULL,target_rank integer NOT NULL CHECK(target_rank>source_rank),reason text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_hold(tenant_id,id),
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TRIGGER booking_upgrade_immutable BEFORE UPDATE OR DELETE ON prsystem.booking_upgrade FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['booking_category_rank','booking_upgrade'] LOOP
 EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
 EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
