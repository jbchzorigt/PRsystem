-- Automatic next-stay preparation reuses exact-version full-plan reconciliation.
ALTER TABLE prsystem.minibar_configuration_request ADD COLUMN next_stay_checkout_id text;
ALTER TABLE prsystem.minibar_configuration_request ADD FOREIGN KEY(tenant_id,next_stay_checkout_id) REFERENCES prsystem.stay_checkout(tenant_id,stay_id);
ALTER TABLE prsystem.minibar_configuration_request ADD UNIQUE(tenant_id,next_stay_checkout_id);
ALTER TABLE prsystem.minibar_configuration_request DROP CONSTRAINT minibar_configuration_request_request_kind_check;
ALTER TABLE prsystem.minibar_configuration_request ADD CHECK(request_kind IN('CONFIGURATION','ROLLOUT','NEXT_STAY'));
CREATE OR REPLACE FUNCTION prsystem.guard_unassigned_rollout_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.assignee_id IS NULL AND (NEW.parent_id IS NOT NULL OR NEW.assignment_version<>0 OR NEW.started_at IS NOT NULL
 OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation e JOIN prsystem.minibar_configuration_request q
 ON(q.tenant_id,q.id)=(e.tenant_id,e.request_id) WHERE e.tenant_id=NEW.tenant_id AND e.source_id=NEW.source_id AND q.request_kind IN('ROLLOUT','NEXT_STAY')))
 THEN RAISE EXCEPTION 'Only canonical rollout tasks may await assignment' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' AND OLD.assignee_id IS NOT NULL AND NEW.assignee_id IS NULL
 THEN RAISE EXCEPTION 'Assigned work cannot become unassigned' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.guard_minibar_configuration_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room prsystem.room%ROWTYPE; template prsystem.minibar_template%ROWTYPE;
 version prsystem.minibar_template_version%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable configuration history' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.state IN ('CANCELLED','APPLIED') OR NEW.state NOT IN ('CANCELLED','APPLIED','IN_PROGRESS','BLOCKED_VARIANCE','BLOCKED_STOCK','READY_FOR_RECONCILIATION') OR NEW.revision<>OLD.revision+1
     OR (to_jsonb(NEW)-ARRAY['state','revision','cancelled_by','cancel_reason','cancelled_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','cancelled_by','cancel_reason','cancelled_at'])
   THEN RAISE EXCEPTION 'Invalid configuration transition' USING ERRCODE='23514'; END IF;
   IF NEW.state='READY_FOR_RECONCILIATION' AND (OLD.request_kind NOT IN('ROLLOUT','NEXT_STAY') OR OLD.state<>'SCHEDULED_AFTER_STAY' OR NOT prsystem.minibar_safe_room(NEW.tenant_id,NEW.room_id,(SELECT source_id FROM prsystem.minibar_reconciliation WHERE tenant_id=NEW.tenant_id AND request_id=NEW.id))) THEN RAISE EXCEPTION 'Rollout safe point required' USING ERRCODE='23514'; END IF;
   IF NEW.state='APPLIED' THEN
     IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_application WHERE tenant_id=NEW.tenant_id AND request_id=NEW.id)
     THEN RAISE EXCEPTION 'Application proof required' USING ERRCODE='23514'; END IF;
   ELSIF NEW.state<>'CANCELLED' THEN
     IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation WHERE tenant_id=NEW.tenant_id AND request_id=NEW.id)
     THEN RAISE EXCEPTION 'Execution proof required' USING ERRCODE='23514'; END IF;
   END IF;
   IF NEW.state='CANCELLED' THEN NEW.cancelled_at:=clock_timestamp(); END IF;
   RETURN NEW;
 END IF;
 SELECT * INTO room FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
 IF NOT FOUND OR room.status='INACTIVE' OR (NEW.target_mode='ON' AND room.status<>'ACTIVE')
    OR (NEW.target_mode='OFF' AND room.minibar_mode='OFF') THEN
   RAISE EXCEPTION 'Invalid configuration room' USING ERRCODE='23514';
 END IF;
 NEW.source_snapshot:=jsonb_build_object('mode',room.minibar_mode,'room_revision',room.revision,'category_id',room.category_id,'application_id',room.minibar_application_id);
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
 IF NEW.request_kind='ROLLOUT' AND (room.minibar_mode<>'ON' OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request q WHERE q.tenant_id=NEW.tenant_id AND q.id=room.minibar_application_id AND q.target_mode='ON' AND q.target_template_id=NEW.target_template_id AND q.target_version_id<>NEW.target_version_id)) THEN RAISE EXCEPTION 'Invalid rollout lineage' USING ERRCODE='23514'; END IF;
 IF NEW.request_kind='NEXT_STAY' THEN
  IF NEW.target_mode<>'ON' OR NEW.next_stay_checkout_id IS NULL OR NEW.rollout_batch_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM prsystem.stay_checkout c JOIN prsystem.stay st ON(st.tenant_id,st.id)=(c.tenant_id,c.stay_id)
   WHERE c.tenant_id=NEW.tenant_id AND c.stay_id=NEW.next_stay_checkout_id AND c.room_id=NEW.room_id AND st.state='CLOSED'
   AND NOT EXISTS(SELECT 1 FROM prsystem.stay newer WHERE newer.tenant_id=st.tenant_id AND newer.room_id=st.room_id AND newer.check_in_recorded_at>st.check_in_recorded_at))
  OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request current WHERE current.tenant_id=NEW.tenant_id AND current.id=room.minibar_application_id
   AND current.target_template_id=NEW.target_template_id AND current.target_version_id=NEW.target_version_id AND current.state='APPLIED')
  THEN RAISE EXCEPTION 'Exact next-stay checkout source required' USING ERRCODE='23514'; END IF;
 ELSIF NEW.next_stay_checkout_id IS NOT NULL THEN RAISE EXCEPTION 'Unexpected next-stay source' USING ERRCODE='23514'; END IF;
 NEW.state:=CASE WHEN NEW.active_stay_id IS NOT NULL OR (NEW.request_kind IN('ROLLOUT','NEXT_STAY') AND NOT prsystem.minibar_safe_room(NEW.tenant_id,NEW.room_id)) THEN 'SCHEDULED_AFTER_STAY' ELSE 'READY_FOR_RECONCILIATION' END;
 NEW.revision:=1; NEW.recorded_at:=clock_timestamp();
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.advance_minibar_rollout(t text,r text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE q prsystem.minibar_configuration_request%ROWTYPE; source text; task text; baseline jsonb; item jsonb;
BEGIN
 -- Room writers use this same row lock; exact source IDs make delivery idempotent.
 PERFORM 1 FROM prsystem.room WHERE tenant_id=t AND id=r FOR UPDATE;
 FOR q IN SELECT * FROM prsystem.minibar_configuration_request WHERE tenant_id=t AND room_id=r
 AND request_kind IN('ROLLOUT','NEXT_STAY') AND state IN ('SCHEDULED_AFTER_STAY','READY_FOR_RECONCILIATION') FOR UPDATE LOOP
  IF EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation WHERE tenant_id=t AND request_id=q.id)
    OR NOT prsystem.minibar_safe_room(t,r) THEN CONTINUE; END IF;
  source:='rollout:'||q.id; task:='rollout:'||q.id;
  baseline:=prsystem.minibar_configuration_baseline(t,q.id);
  INSERT INTO prsystem.cleaning_source(tenant_id,id,room_id,configuration_id,configuration_version,source_kind,source_reference,snapshot)
   VALUES(t,source,r,q.id,q.revision,'CONFIGURATION','canonical-config:'||q.id,
    jsonb_build_object('canonical_minibar',true,'request_id',q.id,'target',q.target_snapshot,'baseline',baseline));
  INSERT INTO prsystem.minibar_reconciliation(tenant_id,request_id,source_id,baseline,created_by)
   VALUES(t,q.id,source,baseline,q.requested_by);
  FOR item IN SELECT * FROM jsonb_array_elements(baseline) LOOP
   INSERT INTO prsystem.cleaning_action(tenant_id,source_id,id,kind,product_id,quantity)
    VALUES(t,source,'rollout:'||q.id||':'||(item->>'product_id'),'COUNT',item->>'product_id',1);
  END LOOP;
  INSERT INTO prsystem.cleaning_task(tenant_id,id,source_id) VALUES(t,task,source);
  IF q.state='SCHEDULED_AFTER_STAY' THEN
   UPDATE prsystem.minibar_configuration_request SET state='READY_FOR_RECONCILIATION',revision=revision+1 WHERE tenant_id=t AND id=q.id;
  END IF;
  INSERT INTO prsystem.operational_event(id,tenant_id,actor_id,kind,source_id,details)
   VALUES('rollout-ready:'||q.id,t,q.requested_by,CASE WHEN q.request_kind='NEXT_STAY' THEN 'MINIBAR_NEXT_STAY_READY' ELSE 'MINIBAR_ROLLOUT_READY' END,q.id,
    jsonb_build_object('task_id',task,'target',q.target_snapshot,'system_transition',true,'original_requester',q.requested_by));
 END LOOP;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.wake_minibar_rollout() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r text;
BEGIN
 IF TG_TABLE_NAME='minibar_configuration_request' THEN
  IF TG_OP='INSERT' AND NEW.request_kind NOT IN('ROLLOUT','NEXT_STAY') THEN RETURN NULL; END IF;
  r:=NEW.room_id;
 ELSIF TG_TABLE_NAME='cleaning_action' THEN
  IF NEW.completed=OLD.completed THEN RETURN NULL; END IF;
  SELECT room_id INTO r FROM prsystem.cleaning_source WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id;
 ELSE
  SELECT room_id INTO r FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND id=NEW.stay_id;
 END IF;
 IF EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND room_id=r
  AND request_kind IN('ROLLOUT','NEXT_STAY') AND state IN ('SCHEDULED_AFTER_STAY','READY_FOR_RECONCILIATION'))
 THEN PERFORM prsystem.advance_minibar_rollout(NEW.tenant_id,r); END IF;
 RETURN NULL;
END; $$;
CREATE FUNCTION prsystem.create_next_stay_minibar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room prsystem.room%ROWTYPE; current prsystem.minibar_configuration_request%ROWTYPE;
BEGIN
 SELECT * INTO room FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
 IF room.minibar_mode<>'ON' OR room.status<>'ACTIVE' THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND room_id=NEW.room_id AND state NOT IN('CANCELLED','APPLIED'))
 OR NOT EXISTS(SELECT 1 FROM prsystem.room_category WHERE tenant_id=NEW.tenant_id AND id=room.category_id AND status='ACTIVE') THEN RETURN NULL; END IF;
 SELECT * INTO current FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=room.minibar_application_id AND state='APPLIED';
 IF NOT FOUND OR current.target_mode<>'ON' THEN RETURN NULL; END IF;
 -- Retirement blocks a new stay; it must not obstruct settlement of this one.
 IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_template WHERE tenant_id=NEW.tenant_id AND id=current.target_template_id AND status='ACTIVE')
 OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_template_version WHERE tenant_id=NEW.tenant_id AND template_id=current.target_template_id AND id=current.target_version_id AND state='PUBLISHED')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(current.target_snapshot->'items') x JOIN prsystem.minibar_product p
  ON p.tenant_id=NEW.tenant_id AND p.id=x->>'product_id' WHERE p.status<>'ACTIVE') THEN RETURN NULL; END IF;
 -- No request is needed when the physical room is already at its exact target.
 IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(current.target_snapshot->'items') x
  WHERE prsystem.minibar_room_quantity(NEW.tenant_id,x->>'product_id',NEW.room_id)<>(x->>'target_quantity')::bigint)
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_product p WHERE p.tenant_id=NEW.tenant_id AND prsystem.minibar_room_quantity(NEW.tenant_id,p.id,NEW.room_id)<>0
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(current.target_snapshot->'items') x WHERE x->>'product_id'=p.id)) THEN RETURN NULL; END IF;
 INSERT INTO prsystem.minibar_configuration_request(tenant_id,id,room_id,target_mode,target_template_id,target_version_id,
  source_snapshot,target_snapshot,state,requested_by,reason,request_kind,next_stay_checkout_id)
 VALUES(NEW.tenant_id,'next-stay:'||NEW.stay_id,NEW.room_id,'ON',current.target_template_id,current.target_version_id,
  '{}','{}','READY_FOR_RECONCILIATION',NEW.actor_id,'Дараагийн зочинд минибар бэлтгэх','NEXT_STAY',NEW.stay_id);
 UPDATE prsystem.room SET revision=revision+1 WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id;
 RETURN NULL;
END; $$;
CREATE TRIGGER next_stay_minibar AFTER INSERT ON prsystem.stay_checkout FOR EACH ROW EXECUTE FUNCTION prsystem.create_next_stay_minibar();
