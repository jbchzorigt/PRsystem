ALTER TABLE prsystem.reception_shift DROP CONSTRAINT reception_shift_state_check;
ALTER TABLE prsystem.reception_shift ADD CHECK(state IN ('OPEN','SUBMITTED','CLOSED'));
ALTER TABLE prsystem.reception_shift DROP CONSTRAINT reception_shift_close_consistency;
ALTER TABLE prsystem.reception_shift ADD CHECK((state IN ('OPEN','SUBMITTED') AND closed_at IS NULL) OR (state='CLOSED' AND closed_at IS NOT NULL AND closed_at>=opened_at));
ALTER TABLE prsystem.reception_shift DROP CONSTRAINT reception_shift_review_state_check;
ALTER TABLE prsystem.reception_shift ADD CHECK(review_state IN ('NOT_SUBMITTED','NOT_REQUIRED','MANAGER_REQUIRED','ADMIN_REQUIRED','APPROVED','DISPUTED'));
DROP INDEX prsystem.one_open_reception_drawer;
DROP INDEX prsystem.one_open_reception_owner;
CREATE UNIQUE INDEX one_open_reception_drawer ON prsystem.reception_shift(tenant_id,drawer_id) WHERE state IN ('OPEN','SUBMITTED');
CREATE UNIQUE INDEX one_open_reception_owner ON prsystem.reception_shift(tenant_id,owner_id) WHERE state IN ('OPEN','SUBMITTED');
CREATE TABLE prsystem.shift_policy (
 tenant_id text PRIMARY KEY REFERENCES prsystem.hotel_access, single_worker boolean NOT NULL,
 revision bigint NOT NULL CHECK(revision>0), configured_by text NOT NULL,
 FOREIGN KEY(tenant_id,configured_by) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TABLE prsystem.shift_handover (
 tenant_id text NOT NULL,id text NOT NULL,shift_id text NOT NULL,drawer_id text NOT NULL,
 sender_id text NOT NULL,receiver_id text NOT NULL,source_custody_id text,
 expected bigint NOT NULL CHECK(expected>=0),sender_actual bigint NOT NULL CHECK(sender_actual>=0),
 book_revision bigint NOT NULL,reason text NOT NULL,self_close boolean NOT NULL,
 state text NOT NULL DEFAULT 'SUBMITTED' CHECK(state IN ('SUBMITTED','RETURNED','ACCEPTED')),
 submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),decided_at timestamptz,decision_reason text,new_shift_id text,
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,shift_id) REFERENCES prsystem.reception_shift,
 FOREIGN KEY(tenant_id,sender_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY(tenant_id,receiver_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY(tenant_id,new_shift_id) REFERENCES prsystem.reception_shift,
 CHECK((state='SUBMITTED' AND decided_at IS NULL) OR(state<>'SUBMITTED' AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_handover ON prsystem.shift_handover(tenant_id,shift_id) WHERE state='SUBMITTED';
CREATE TABLE prsystem.handover_count (
 tenant_id text NOT NULL,id text NOT NULL,handover_id text NOT NULL,actor_id text NOT NULL,
 actual bigint NOT NULL CHECK(actual>=0),counted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,handover_id) REFERENCES prsystem.shift_handover,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TRIGGER handover_count_immutable BEFORE UPDATE OR DELETE ON prsystem.handover_count FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.cash_custody (
 tenant_id text NOT NULL,id text NOT NULL,handover_id text NOT NULL,drawer_id text NOT NULL,owner_id text NOT NULL,
 state text NOT NULL DEFAULT 'HELD' CHECK(state IN ('HELD','RELEASED')),released_at timestamptz,
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,handover_id),FOREIGN KEY(tenant_id,handover_id) REFERENCES prsystem.shift_handover,
 FOREIGN KEY(tenant_id,drawer_id) REFERENCES prsystem.cash_drawer,
 FOREIGN KEY(tenant_id,owner_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE UNIQUE INDEX one_held_custody ON prsystem.cash_custody(tenant_id,drawer_id) WHERE state='HELD';
ALTER TABLE prsystem.shift_handover ADD FOREIGN KEY(tenant_id,source_custody_id) REFERENCES prsystem.cash_custody;
CREATE FUNCTION prsystem.preserve_handover() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable handover' USING ERRCODE='23514'; END IF;
 IF OLD.state<>'SUBMITTED' OR (to_jsonb(NEW)-ARRAY['state','decided_at','decision_reason','new_shift_id']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['state','decided_at','decision_reason','new_shift_id']) THEN
 RAISE EXCEPTION 'Immutable handover' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER handover_immutable BEFORE UPDATE OR DELETE ON prsystem.shift_handover FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_handover();
REVOKE ALL ON prsystem.shift_policy,prsystem.shift_handover,prsystem.handover_count,prsystem.cash_custody FROM PUBLIC;
