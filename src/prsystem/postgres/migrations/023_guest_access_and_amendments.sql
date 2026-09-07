CREATE TABLE prsystem.room_guest_qr (
 tenant_id text NOT NULL, room_id text NOT NULL, token_hash text NOT NULL UNIQUE,
 envelope jsonb NOT NULL, revision bigint NOT NULL CHECK(revision>0),
 failures integer NOT NULL DEFAULT 0, blocked_until timestamptz,
 PRIMARY KEY(tenant_id,room_id), FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room
);
CREATE TABLE prsystem.guest_session (
 token_hash text PRIMARY KEY, tenant_id text NOT NULL, room_id text NOT NULL, stay_id text NOT NULL,
 qr_revision bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), revoked_at timestamptz,
 FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay,
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room
);
CREATE INDEX guest_session_stay ON prsystem.guest_session(tenant_id,stay_id) WHERE revoked_at IS NULL;
CREATE TABLE prsystem.stay_time_amendment (
 tenant_id text NOT NULL, id text NOT NULL, stay_id text NOT NULL, requester_id text NOT NULL,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(), actual_checkin_at timestamptz NOT NULL,
 reason_envelope jsonb NOT NULL, state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','APPROVED','REJECTED')),
 decider_id text, decided_at timestamptz, decision_reason text, self_approved boolean,
 PRIMARY KEY(tenant_id,id), FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay,
 FOREIGN KEY(tenant_id,requester_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY(tenant_id,decider_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 CHECK ((state='PENDING' AND decider_id IS NULL AND decided_at IS NULL) OR (state<>'PENDING' AND decider_id IS NOT NULL AND decided_at IS NOT NULL))
);
CREATE UNIQUE INDEX one_pending_time_amendment ON prsystem.stay_time_amendment(tenant_id,stay_id) WHERE state='PENDING';
CREATE FUNCTION prsystem.preserve_time_amendment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable amendment' USING ERRCODE='23514'; END IF;
 IF OLD.state<>'PENDING' OR (to_jsonb(NEW)-ARRAY['state','decider_id','decided_at','decision_reason','self_approved']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['state','decider_id','decided_at','decision_reason','self_approved']) THEN
 RAISE EXCEPTION 'Immutable amendment' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER time_amendment_immutable BEFORE UPDATE OR DELETE ON prsystem.stay_time_amendment
FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_time_amendment();
REVOKE ALL ON prsystem.room_guest_qr,prsystem.guest_session,prsystem.stay_time_amendment FROM PUBLIC;
