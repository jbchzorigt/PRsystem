-- Pre-movement configuration requests. Reconciliation/apply is a later adapter.
CREATE TABLE prsystem.minibar_configuration_request (
 tenant_id text NOT NULL,
 id text NOT NULL,
 room_id text NOT NULL,
 target_mode text NOT NULL CHECK(target_mode IN ('ON','OFF')),
 target_template_id text,
 target_version_id text,
 source_snapshot jsonb NOT NULL,
 target_snapshot jsonb NOT NULL,
 active_stay_id text,
 state text NOT NULL CHECK(state IN ('SCHEDULED_AFTER_STAY','READY_FOR_RECONCILIATION','CANCELLED')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 requested_by text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 cancelled_by text,
 cancel_reason text,
 cancelled_at timestamptz,
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room(tenant_id,id),
 FOREIGN KEY(tenant_id,target_template_id,target_version_id) REFERENCES prsystem.minibar_template_version(tenant_id,template_id,id),
 FOREIGN KEY(tenant_id,active_stay_id) REFERENCES prsystem.stay(tenant_id,id),
 FOREIGN KEY(tenant_id,requested_by) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY(tenant_id,cancelled_by) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 CHECK((target_mode='ON' AND target_template_id IS NOT NULL AND target_version_id IS NOT NULL)
    OR (target_mode='OFF' AND target_template_id IS NULL AND target_version_id IS NULL)),
 CHECK((state='CANCELLED' AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) BETWEEN 1 AND 1000)
    OR (state<>'CANCELLED' AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL))
);
CREATE UNIQUE INDEX one_pending_minibar_configuration ON prsystem.minibar_configuration_request(tenant_id,room_id) WHERE state<>'CANCELLED';

CREATE FUNCTION prsystem.guard_minibar_configuration_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room prsystem.room%ROWTYPE; template prsystem.minibar_template%ROWTYPE;
 version prsystem.minibar_template_version%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable configuration history' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.state='CANCELLED' OR NEW.state<>'CANCELLED' OR NEW.revision<>OLD.revision+1
     OR (to_jsonb(NEW)-ARRAY['state','revision','cancelled_by','cancel_reason','cancelled_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','cancelled_by','cancel_reason','cancelled_at'])
   THEN RAISE EXCEPTION 'Invalid configuration transition' USING ERRCODE='23514'; END IF;
   NEW.cancelled_at:=clock_timestamp(); RETURN NEW;
 END IF;
 SELECT * INTO room FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
 IF NOT FOUND OR room.status='INACTIVE' OR (NEW.target_mode='ON' AND room.status<>'ACTIVE')
    OR (NEW.target_mode='OFF' AND room.minibar_mode='OFF') THEN
   RAISE EXCEPTION 'Invalid configuration room' USING ERRCODE='23514';
 END IF;
 NEW.source_snapshot:=jsonb_build_object('mode',room.minibar_mode,'room_revision',room.revision,'category_id',room.category_id);
 IF NEW.target_mode='ON' THEN
   PERFORM 1 FROM prsystem.room_category WHERE tenant_id=NEW.tenant_id AND id=room.category_id AND status='ACTIVE' FOR SHARE;
   IF NOT FOUND THEN RAISE EXCEPTION 'Inactive configuration category' USING ERRCODE='23514'; END IF;
   SELECT * INTO template FROM prsystem.minibar_template WHERE tenant_id=NEW.tenant_id AND id=NEW.target_template_id FOR UPDATE;
   SELECT * INTO version FROM prsystem.minibar_template_version WHERE tenant_id=NEW.tenant_id AND template_id=NEW.target_template_id AND id=NEW.target_version_id FOR SHARE;
   PERFORM 1 FROM prsystem.minibar_product p JOIN prsystem.minibar_template_item i
     ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id) WHERE i.tenant_id=NEW.tenant_id
     AND i.template_id=NEW.target_template_id AND i.version_id=NEW.target_version_id ORDER BY p.id FOR SHARE OF p;
   IF template.status IS DISTINCT FROM 'ACTIVE' OR version.state IS DISTINCT FROM 'PUBLISHED'
      OR EXISTS(SELECT 1 FROM prsystem.minibar_template_item i JOIN prsystem.minibar_product p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id)
       WHERE i.tenant_id=NEW.tenant_id AND i.template_id=NEW.target_template_id AND i.version_id=NEW.target_version_id AND p.status<>'ACTIVE')
   THEN RAISE EXCEPTION 'Invalid configuration target' USING ERRCODE='23514'; END IF;
   NEW.target_snapshot:=jsonb_build_object('mode','ON','template_id',template.id,'template_name',template.name,
      'version_id',version.id,'version_number',version.version_number,'items',version.published_items);
 ELSE NEW.target_snapshot:=jsonb_build_object('mode','OFF','items','[]'::jsonb);
 END IF;
 SELECT id INTO NEW.active_stay_id FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND room_id=NEW.room_id AND state='ACTIVE';
 NEW.state:=CASE WHEN NEW.active_stay_id IS NOT NULL THEN 'SCHEDULED_AFTER_STAY' ELSE 'READY_FOR_RECONCILIATION' END;
 NEW.revision:=1; NEW.recorded_at:=clock_timestamp();
 RETURN NEW;
END; $$;
CREATE TRIGGER minibar_configuration_guard BEFORE INSERT OR UPDATE OR DELETE ON prsystem.minibar_configuration_request
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_configuration_request();

CREATE FUNCTION prsystem.sync_minibar_configuration_blocker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO prsystem.reception_dependency_blocker(tenant_id,room_id,source_kind,source_id,state)
 VALUES(NEW.tenant_id,NEW.room_id,'MINIBAR_CONFIGURATION',NEW.id,CASE WHEN NEW.state='CANCELLED' THEN 'DONE' ELSE 'OPEN' END)
 ON CONFLICT(tenant_id,source_kind,source_id) DO UPDATE SET state=EXCLUDED.state;
 RETURN NULL;
END; $$;
CREATE TRIGGER minibar_configuration_blocker AFTER INSERT OR UPDATE ON prsystem.minibar_configuration_request
 FOR EACH ROW EXECUTE FUNCTION prsystem.sync_minibar_configuration_blocker();

CREATE FUNCTION prsystem.guard_configuration_blocker() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE request_state text; request_room text;
BEGIN
 IF TG_OP<>'INSERT' AND OLD.source_kind='MINIBAR_CONFIGURATION' THEN
   IF TG_OP='DELETE' OR (NEW.tenant_id,NEW.room_id,NEW.source_kind,NEW.source_id)
       IS DISTINCT FROM (OLD.tenant_id,OLD.room_id,OLD.source_kind,OLD.source_id)
   THEN RAISE EXCEPTION 'Configuration blocker identity retained' USING ERRCODE='23514'; END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 IF NEW.source_kind='MINIBAR_CONFIGURATION' THEN
   SELECT state,room_id INTO request_state,request_room FROM prsystem.minibar_configuration_request
     WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id;
   IF request_state IS NULL OR request_room<>NEW.room_id
     OR NEW.state<>CASE WHEN request_state='CANCELLED' THEN 'DONE' ELSE 'OPEN' END
   THEN RAISE EXCEPTION 'Configuration blocker disagrees with source' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER configuration_blocker_guard BEFORE INSERT OR UPDATE OR DELETE ON prsystem.reception_dependency_blocker
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_configuration_blocker();

CREATE FUNCTION prsystem.block_pending_configuration_assignment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM prsystem.reception_dependency_blocker WHERE tenant_id=NEW.tenant_id AND room_id=NEW.room_id
     AND source_kind='MINIBAR_CONFIGURATION' AND state='OPEN')
 THEN RAISE EXCEPTION 'Configuration change pending' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pending_configuration_stay BEFORE INSERT ON prsystem.stay
 FOR EACH ROW EXECUTE FUNCTION prsystem.block_pending_configuration_assignment();
CREATE TRIGGER pending_configuration_reservation BEFORE INSERT ON prsystem.room_reservation
 FOR EACH ROW WHEN(NEW.state='CONFIRMED') EXECUTE FUNCTION prsystem.block_pending_configuration_assignment();
CREATE TRIGGER pending_configuration_stay_reassignment BEFORE UPDATE OF room_id,state ON prsystem.stay
 FOR EACH ROW WHEN(NEW.state='ACTIVE' AND (NEW.room_id,NEW.state) IS DISTINCT FROM (OLD.room_id,OLD.state))
 EXECUTE FUNCTION prsystem.block_pending_configuration_assignment();
CREATE TRIGGER pending_configuration_reservation_reassignment BEFORE UPDATE OF room_id,state ON prsystem.room_reservation
 FOR EACH ROW WHEN(NEW.state='CONFIRMED' AND (NEW.room_id,NEW.state) IS DISTINCT FROM (OLD.room_id,OLD.state))
 EXECUTE FUNCTION prsystem.block_pending_configuration_assignment();

CREATE FUNCTION prsystem.preserve_pending_room_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.minibar_mode,NEW.category_id) IS DISTINCT FROM (OLD.minibar_mode,OLD.category_id) THEN
   IF EXISTS(SELECT 1 FROM prsystem.reception_dependency_blocker WHERE tenant_id=OLD.tenant_id AND room_id=OLD.id
      AND source_kind='MINIBAR_CONFIGURATION' AND state='OPEN')
 THEN RAISE EXCEPTION 'Configuration change pending' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER pending_room_configuration BEFORE UPDATE ON prsystem.room
 FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_pending_room_configuration();
ALTER TABLE prsystem.minibar_configuration_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.minibar_configuration_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.minibar_configuration_request
 USING(tenant_id=current_setting('prsystem.tenant_id',true)) WITH CHECK(tenant_id=current_setting('prsystem.tenant_id',true));
REVOKE ALL ON prsystem.minibar_configuration_request FROM PUBLIC;
