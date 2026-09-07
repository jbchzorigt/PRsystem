-- Historical readiness begins at this migration for legacy rooms, never earlier.
CREATE TABLE prsystem.room_readiness_event (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id text NOT NULL, room_id text NOT NULL,
    cleaning_state text NOT NULL CHECK (cleaning_state IN ('DIRTY','CLEANING','CLEAN')),
    room_status text NOT NULL, category_id text NOT NULL, category_status text NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (tenant_id,room_id,sequence),
    FOREIGN KEY (tenant_id,room_id) REFERENCES prsystem.room,
    FOREIGN KEY (tenant_id,category_id) REFERENCES prsystem.room_category
);
CREATE INDEX readiness_history ON prsystem.room_readiness_event (tenant_id,room_id,recorded_at DESC,sequence DESC);
CREATE TRIGGER readiness_immutable BEFORE UPDATE OR DELETE ON prsystem.room_readiness_event
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE FUNCTION prsystem.record_room_readiness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO prsystem.room_readiness_event (tenant_id,room_id,cleaning_state,room_status,category_id,category_status)
    SELECT NEW.tenant_id,NEW.id,NEW.cleaning_state,NEW.status,NEW.category_id,c.status
    FROM prsystem.room_category c WHERE (c.tenant_id,c.id)=(NEW.tenant_id,NEW.category_id);
    RETURN NEW;
END; $$;
CREATE TRIGGER room_initial_readiness AFTER INSERT ON prsystem.room
FOR EACH ROW EXECUTE FUNCTION prsystem.record_room_readiness();
CREATE TRIGGER room_changed_readiness AFTER UPDATE OF cleaning_state,status,category_id ON prsystem.room
FOR EACH ROW WHEN (OLD.cleaning_state IS DISTINCT FROM NEW.cleaning_state OR OLD.status IS DISTINCT FROM NEW.status OR OLD.category_id IS DISTINCT FROM NEW.category_id)
EXECUTE FUNCTION prsystem.record_room_readiness();
CREATE FUNCTION prsystem.record_category_readiness() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO prsystem.room_readiness_event (tenant_id,room_id,cleaning_state,room_status,category_id,category_status)
    SELECT r.tenant_id,r.id,r.cleaning_state,r.status,r.category_id,NEW.status
    FROM prsystem.room r WHERE (r.tenant_id,r.category_id)=(NEW.tenant_id,NEW.id) ORDER BY r.id;
    RETURN NEW;
END; $$;
CREATE TRIGGER category_changed_readiness AFTER UPDATE OF status ON prsystem.room_category
FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION prsystem.record_category_readiness();
INSERT INTO prsystem.room_readiness_event (tenant_id,room_id,cleaning_state,room_status,category_id,category_status)
SELECT r.tenant_id,r.id,r.cleaning_state,r.status,r.category_id,c.status FROM prsystem.room r
JOIN prsystem.room_category c ON (c.tenant_id,c.id)=(r.tenant_id,r.category_id);

CREATE TABLE prsystem.room_cleaning_request (
    tenant_id text NOT NULL, source_id text NOT NULL, room_id text NOT NULL,
    state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','DONE')),
    PRIMARY KEY (tenant_id,source_id),
    FOREIGN KEY (tenant_id,source_id) REFERENCES prsystem.cleaning_source,
    FOREIGN KEY (tenant_id,room_id) REFERENCES prsystem.room
);
CREATE UNIQUE INDEX room_one_cleaning_request ON prsystem.room_cleaning_request (tenant_id,room_id) WHERE state='OPEN';

CREATE TABLE prsystem.stay (
    tenant_id text NOT NULL, id text NOT NULL, room_id text NOT NULL, shift_id text NOT NULL, actor_id text NOT NULL,
    origin text NOT NULL DEFAULT 'WALK_IN' CHECK (origin='WALK_IN'),
    kind text NOT NULL CHECK (kind IN ('HOURLY','NIGHTLY')),
    duration_units bigint NOT NULL CHECK (duration_units>0),
    actual_checkin_at timestamptz NOT NULL, check_in_recorded_at timestamptz NOT NULL,
    planned_checkout_at timestamptz NOT NULL,
    backdate_reason_envelope jsonb,
    amount_mnt bigint NOT NULL CHECK (amount_mnt>0),
    deposit_mnt bigint NOT NULL CHECK (deposit_mnt>=0),
    cleaning_buffer_minutes integer NOT NULL CHECK (cleaning_buffer_minutes>=0),
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object'),
    readiness_sequence bigint NOT NULL,
    state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','CLOSED')),
    actual_checkout_at timestamptz,
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,room_id) REFERENCES prsystem.room,
    FOREIGN KEY (tenant_id,room_id,readiness_sequence) REFERENCES prsystem.room_readiness_event (tenant_id,room_id,sequence),
    FOREIGN KEY (tenant_id,shift_id) REFERENCES prsystem.reception_shift,
    FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    CHECK (actual_checkin_at<=check_in_recorded_at AND planned_checkout_at>check_in_recorded_at),
    CHECK ((state='ACTIVE' AND actual_checkout_at IS NULL) OR (state='CLOSED' AND actual_checkout_at IS NOT NULL AND actual_checkout_at>=actual_checkin_at))
);
CREATE UNIQUE INDEX room_one_active_stay ON prsystem.stay (tenant_id,room_id) WHERE state='ACTIVE';
CREATE INDEX stay_room_history ON prsystem.stay (tenant_id,room_id,actual_checkin_at);
CREATE FUNCTION prsystem.preserve_stay_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable stay history' USING ERRCODE='23514'; END IF;
    IF (to_jsonb(NEW)-ARRAY['state','actual_checkout_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','actual_checkout_at'])
       OR OLD.state='CLOSED' THEN RAISE EXCEPTION 'Immutable stay snapshot' USING ERRCODE='23514'; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER stay_snapshot_immutable BEFORE UPDATE OR DELETE ON prsystem.stay
FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_stay_snapshot();
CREATE TABLE prsystem.stay_guest_identity (
    tenant_id text NOT NULL, stay_id text NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK (revision=1),
    identity_type text NOT NULL CHECK (identity_type IN ('MN_REG_NO','FOREIGN_PASSPORT','OTHER_GOV_ID','NO_DOCUMENT')),
    provenance text NOT NULL CHECK (provenance='MANUAL'),
    envelope jsonb NOT NULL, lookup_token text,
    PRIMARY KEY (tenant_id,stay_id,revision),
    FOREIGN KEY (tenant_id,stay_id) REFERENCES prsystem.stay
);
CREATE INDEX guest_identity_exact_token ON prsystem.stay_guest_identity (lookup_token) WHERE lookup_token IS NOT NULL;
CREATE TRIGGER guest_identity_immutable BEFORE UPDATE OR DELETE ON prsystem.stay_guest_identity
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
-- Isolated downstream handoff, no wanted/case/match results or hotel read API.
CREATE TABLE prsystem.identity_match_outbox (
    tenant_id text NOT NULL, stay_id text NOT NULL, identity_revision bigint NOT NULL,
    recorded_at timestamptz NOT NULL, lookup_token text NOT NULL,
    PRIMARY KEY (tenant_id,stay_id,identity_revision),
    FOREIGN KEY (tenant_id,stay_id,identity_revision) REFERENCES prsystem.stay_guest_identity
);
CREATE TRIGGER match_request_immutable BEFORE UPDATE OR DELETE ON prsystem.identity_match_outbox
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.stay_guest_code (
    tenant_id text NOT NULL, stay_id text NOT NULL, id text NOT NULL,
    code_hash text NOT NULL, envelope jsonb NOT NULL,
    created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
    consumed_at timestamptz, revoked_at timestamptz,
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,stay_id) REFERENCES prsystem.stay,
    CHECK (expires_at>created_at)
);
-- Reservation projection is written only by the future confirmed-booking
-- transaction under the same room root lock. No public reservation import API.
CREATE TABLE prsystem.room_reservation (
    tenant_id text NOT NULL, id text NOT NULL, room_id text NOT NULL,
    planned_checkin_at timestamptz NOT NULL, planned_checkout_at timestamptz NOT NULL,
    cleaning_buffer_minutes integer NOT NULL CHECK (cleaning_buffer_minutes>=0),
    source_reference text NOT NULL,
    state text NOT NULL CHECK (state IN ('CONFIRMED','CANCELLED')),
    PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,source_reference),
    FOREIGN KEY (tenant_id,room_id) REFERENCES prsystem.room,
    CHECK (planned_checkin_at<planned_checkout_at)
);
CREATE INDEX reservation_room_interval ON prsystem.room_reservation (tenant_id,room_id,planned_checkin_at) WHERE state='CONFIRMED';
REVOKE ALL ON prsystem.room_readiness_event,prsystem.room_cleaning_request,prsystem.stay,
prsystem.stay_guest_identity,prsystem.identity_match_outbox,prsystem.stay_guest_code,prsystem.room_reservation FROM PUBLIC;
