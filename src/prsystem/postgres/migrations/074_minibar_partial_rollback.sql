-- Partial physical movements retain the original task, count source and baseline.
-- Cancellation becomes a compensating task; it never deletes inventory history.
ALTER TABLE prsystem.minibar_transfer DROP CONSTRAINT minibar_transfer_tenant_id_request_id_product_id_key;
ALTER TABLE prsystem.minibar_transfer ADD COLUMN phase text NOT NULL DEFAULT 'APPLY' CHECK(phase IN('APPLY','PARTIAL','ROLLBACK'));
ALTER TABLE prsystem.minibar_transfer ADD COLUMN execution_step_id text;
CREATE TABLE prsystem.minibar_execution_step (
 tenant_id text NOT NULL,id text NOT NULL,request_id text NOT NULL,task_id text NOT NULL,actor_id text NOT NULL,
 assignment_version bigint NOT NULL,request_revision bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN('PARTIAL','ROLLBACK','ROLLBACK_COMPLETE')),
 transaction_id xid8 NOT NULL DEFAULT pg_current_xact_id(),observed_counts jsonb NOT NULL DEFAULT '{}',recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id,request_revision),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_reconciliation,
 FOREIGN KEY(tenant_id,task_id) REFERENCES prsystem.cleaning_task(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 CHECK(jsonb_typeof(observed_counts)='object')
);
ALTER TABLE prsystem.minibar_transfer ADD FOREIGN KEY(tenant_id,execution_step_id) REFERENCES prsystem.minibar_execution_step;
ALTER TABLE prsystem.minibar_transfer ADD CHECK((phase='APPLY')=(execution_step_id IS NULL));
CREATE UNIQUE INDEX minibar_one_transfer_per_step ON prsystem.minibar_transfer(tenant_id,execution_step_id) WHERE execution_step_id IS NOT NULL;
CREATE TABLE prsystem.minibar_rollback_request (
 tenant_id text NOT NULL,request_id text NOT NULL,actor_id text NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 baseline jsonb NOT NULL,movement_ids jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id),FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_reconciliation,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_execution_step','minibar_rollback_request'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
ALTER TABLE prsystem.minibar_configuration_request DROP CONSTRAINT minibar_configuration_request_state_check;
ALTER TABLE prsystem.minibar_configuration_request ADD CHECK(state IN('SCHEDULED_AFTER_STAY','READY_FOR_RECONCILIATION','IN_PROGRESS','BLOCKED_VARIANCE','BLOCKED_STOCK','APPLIED','CANCELLED','ROLLBACK_REQUIRED','ROLLED_BACK'));
-- Locate only the original cancellation metadata check, whose generated name is not a public contract.
DO $$ DECLARE c text; BEGIN
 SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid='prsystem.minibar_configuration_request'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%cancelled_by%';
 EXECUTE format('ALTER TABLE prsystem.minibar_configuration_request DROP CONSTRAINT %I',c);
END; $$;
ALTER TABLE prsystem.minibar_configuration_request ADD CHECK(
 (state IN('CANCELLED','ROLLBACK_REQUIRED','ROLLED_BACK') AND cancelled_by IS NOT NULL AND cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL AND length(btrim(cancel_reason)) BETWEEN 1 AND 1000)
 OR(state NOT IN('CANCELLED','ROLLBACK_REQUIRED','ROLLED_BACK') AND cancelled_by IS NULL AND cancelled_at IS NULL AND cancel_reason IS NULL));
DROP INDEX prsystem.one_pending_minibar_configuration;
CREATE UNIQUE INDEX one_pending_minibar_configuration ON prsystem.minibar_configuration_request(tenant_id,room_id) WHERE state NOT IN('CANCELLED','APPLIED','ROLLED_BACK');


CREATE OR REPLACE FUNCTION prsystem.sync_minibar_configuration_blocker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO prsystem.reception_dependency_blocker(tenant_id,room_id,source_kind,source_id,state)
 VALUES(NEW.tenant_id,NEW.room_id,'MINIBAR_CONFIGURATION',NEW.id,CASE WHEN NEW.state IN ('CANCELLED','APPLIED','ROLLED_BACK') THEN 'DONE' ELSE 'OPEN' END)
 ON CONFLICT(tenant_id,source_kind,source_id) DO UPDATE SET state=EXCLUDED.state;
 RETURN NULL;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.guard_configuration_blocker() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR NEW.state IS DISTINCT FROM (CASE WHEN request_state IN ('CANCELLED','APPLIED','ROLLED_BACK') THEN 'DONE' ELSE 'OPEN' END)
   THEN RAISE EXCEPTION 'Configuration blocker disagrees with source' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.minibar_version_archive_blockers(t text,p text,v text)
RETURNS TABLE(kind text,source_id text) LANGUAGE sql STABLE AS $$
 SELECT 'DEFAULT',id FROM prsystem.minibar_template WHERE tenant_id=t AND id=p AND default_version_id=v
 UNION ALL
 SELECT 'CURRENT_ROOM',r.id FROM prsystem.room r JOIN prsystem.minibar_configuration_request q
 ON(q.tenant_id,q.id)=(r.tenant_id,r.minibar_application_id)
 WHERE r.tenant_id=t AND r.minibar_mode='ON' AND q.target_template_id=p AND q.target_version_id=v
 UNION ALL
 SELECT 'PENDING_TARGET',q.id FROM prsystem.minibar_configuration_request q
 WHERE q.tenant_id=t AND q.state NOT IN ('APPLIED','CANCELLED','ROLLED_BACK') AND q.target_template_id=p AND q.target_version_id=v
 UNION ALL
 SELECT 'PENDING_SOURCE',q.id FROM prsystem.minibar_configuration_request q JOIN prsystem.minibar_configuration_request old
 ON old.tenant_id=q.tenant_id AND old.id=q.source_snapshot->>'application_id'
 WHERE q.tenant_id=t AND q.state NOT IN ('APPLIED','CANCELLED','ROLLED_BACK') AND old.target_template_id=p AND old.target_version_id=v
 UNION ALL
 SELECT 'ACTIVE_STAY',s.id FROM prsystem.stay s WHERE s.tenant_id=t AND s.state='ACTIVE'
 AND s.snapshot->'minibar_snapshot'->>'template_id'=p AND s.snapshot->'minibar_snapshot'->>'version_id'=v
 UNION ALL
 SELECT 'CLEANER_TASK',c.id FROM prsystem.cleaning_task c JOIN prsystem.minibar_reconciliation e
 ON(e.tenant_id,e.source_id)=(c.tenant_id,c.source_id)
 JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(e.tenant_id,e.request_id)
 LEFT JOIN prsystem.minibar_configuration_request old ON old.tenant_id=q.tenant_id AND old.id=q.source_snapshot->>'application_id'
 WHERE c.tenant_id=t AND c.state='OPEN' AND ((q.target_template_id=p AND q.target_version_id=v)
 OR(old.target_template_id=p AND old.target_version_id=v))
$$;

CREATE OR REPLACE FUNCTION prsystem.create_next_stay_minibar() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room prsystem.room%ROWTYPE; current prsystem.minibar_configuration_request%ROWTYPE;
BEGIN
 SELECT * INTO room FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
 IF room.minibar_mode<>'ON' OR room.status<>'ACTIVE' THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND room_id=NEW.room_id AND state NOT IN('CANCELLED','APPLIED','ROLLED_BACK'))
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

CREATE OR REPLACE FUNCTION prsystem.minibar_booking_eligible(t text,r text) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE room prsystem.room%ROWTYPE;
BEGIN
 SELECT * INTO room FROM prsystem.room WHERE tenant_id=t AND id=r;
 IF NOT FOUND OR room.status<>'ACTIVE' OR NOT EXISTS(SELECT 1 FROM prsystem.room_category
  WHERE tenant_id=t AND id=room.category_id AND status='ACTIVE') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM prsystem.reception_dependency_blocker WHERE tenant_id=t AND room_id=r
  AND state='OPEN' AND (source_kind<>'CANONICAL_MINIBAR' OR room.minibar_mode<>'ON')) THEN RETURN false; END IF;
 IF room.minibar_mode='OFF' THEN RETURN true; END IF;
 IF room.minibar_mode<>'ON' THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM prsystem.hotel_access WHERE tenant_id=t AND package_mnt IN(25000,30000))
  OR EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request WHERE tenant_id=t AND room_id=r
   AND state NOT IN('APPLIED','CANCELLED','ROLLED_BACK')) THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request q
  JOIN prsystem.minibar_configuration_application a ON(a.tenant_id,a.request_id,a.room_id)=(q.tenant_id,q.id,q.room_id)
  JOIN prsystem.minibar_template p ON(p.tenant_id,p.id)=(q.tenant_id,q.target_template_id)
  JOIN prsystem.minibar_template_version v ON(v.tenant_id,v.template_id,v.id)=(q.tenant_id,q.target_template_id,q.target_version_id)
  WHERE q.tenant_id=t AND q.id=room.minibar_application_id AND q.room_id=r
  AND q.state='APPLIED' AND q.target_mode='ON' AND p.status='ACTIVE' AND v.state='PUBLISHED'
  AND jsonb_array_length(q.target_snapshot->'items')>0
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.target_snapshot->'items') x
   LEFT JOIN prsystem.minibar_product product ON product.tenant_id=t AND product.id=x->>'product_id'
   WHERE product.status IS DISTINCT FROM 'ACTIVE'));
END; $$;

CREATE OR REPLACE FUNCTION prsystem.minibar_entity_blockers(t text,k text,e text)
RETURNS TABLE(kind text,source_id text) LANGUAGE sql STABLE AS $$
 SELECT 'ROOM_STOCK',r.id FROM prsystem.room r WHERE k='product' AND r.tenant_id=t
 AND prsystem.minibar_room_quantity(t,e,r.id)>0
 UNION ALL
 SELECT 'ACTIVE_TEMPLATE',v.template_id||':'||v.id FROM prsystem.minibar_template_version v
 JOIN prsystem.minibar_template p ON(p.tenant_id,p.id)=(v.tenant_id,v.template_id)
 WHERE k='product' AND v.tenant_id=t AND v.state='PUBLISHED' AND p.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.published_items) x WHERE x->>'product_id'=e)
 UNION ALL
 SELECT 'CURRENT_ROOM',r.id FROM prsystem.room r JOIN prsystem.minibar_configuration_request q
 ON(q.tenant_id,q.id)=(r.tenant_id,r.minibar_application_id) WHERE r.tenant_id=t AND r.minibar_mode='ON'
 AND ((k='template' AND q.target_template_id=e) OR(k='product' AND EXISTS(
 SELECT 1 FROM jsonb_array_elements(q.target_snapshot->'items') x WHERE x->>'product_id'=e)))
 UNION ALL
 SELECT 'ACTIVE_STAY',s.id FROM prsystem.stay s WHERE s.tenant_id=t AND s.state='ACTIVE'
 AND ((k='template' AND s.snapshot->'minibar_snapshot'->>'template_id'=e) OR(k='product' AND EXISTS(
 SELECT 1 FROM jsonb_array_elements(s.snapshot->'minibar_snapshot'->'items') x WHERE x->>'product_id'=e)))
 UNION ALL
 SELECT 'PENDING_CONFIGURATION',q.id FROM prsystem.minibar_configuration_request q
 LEFT JOIN prsystem.minibar_configuration_request old ON old.tenant_id=q.tenant_id AND old.id=q.source_snapshot->>'application_id'
 WHERE q.tenant_id=t AND q.state NOT IN('APPLIED','CANCELLED','ROLLED_BACK') AND
 ((k='template' AND (q.target_template_id=e OR old.target_template_id=e)) OR(k='product' AND EXISTS(
 SELECT 1 FROM jsonb_array_elements(coalesce(q.target_snapshot->'items','[]')||coalesce(old.target_snapshot->'items','[]')) x WHERE x->>'product_id'=e)))
 UNION ALL
 SELECT 'PENDING_REFILL',q.id FROM prsystem.minibar_refill_request q
 JOIN prsystem.stay s ON(s.tenant_id,s.id)=(q.tenant_id,q.stay_id)
 WHERE q.tenant_id=t AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_refill_result z WHERE(z.tenant_id,z.request_id)=(q.tenant_id,q.id))
 AND ((k='product' AND q.product_id=e) OR(k='template' AND s.snapshot->'minibar_snapshot'->>'template_id'=e))
$$;

CREATE OR REPLACE FUNCTION prsystem.minibar_count_resolution_ready(t text,r text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM prsystem.minibar_count_resolution v JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(v.tenant_id,v.request_id)
 WHERE v.tenant_id=t AND v.id=r AND q.state NOT IN('APPLIED','CANCELLED','ROLLED_BACK','ROLLBACK_REQUIRED')
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_count_resolution newer WHERE newer.tenant_id=t AND newer.request_id=v.request_id AND newer.product_id=v.product_id AND newer.request_revision>v.request_revision)
 AND prsystem.minibar_variance_authorized(t,v.actor_id)
 AND v.physical_quantity=prsystem.minibar_room_quantity(t,v.product_id,v.room_id)
 AND v.stock_revision=(SELECT stock_revision FROM prsystem.minibar_receipt WHERE tenant_id=t AND product_id=v.product_id ORDER BY stock_revision DESC LIMIT 1))
$$;

CREATE OR REPLACE FUNCTION prsystem.minibar_adjustment_scope_ready(t text,p text,r text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT r IS NULL OR NOT EXISTS(
 SELECT 1 FROM prsystem.minibar_reconciliation e JOIN prsystem.minibar_configuration_request q
 ON(q.tenant_id,q.id)=(e.tenant_id,e.request_id)
 WHERE q.tenant_id=t AND q.room_id=r AND q.state NOT IN('APPLIED','CANCELLED','ROLLED_BACK')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.baseline) b WHERE b->>'product_id'=p))
$$;

CREATE OR REPLACE FUNCTION prsystem.minibar_safe_room(t text,r text,own_source text DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM prsystem.stay s LEFT JOIN prsystem.stay_checkout c ON(c.tenant_id,c.stay_id)=(s.tenant_id,s.id)
   WHERE s.tenant_id=t AND s.room_id=r AND (s.state='ACTIVE' OR c.stay_id IS NULL))
 AND NOT EXISTS(SELECT 1 FROM prsystem.cleaning_source s JOIN prsystem.cleaning_action a ON(a.tenant_id,a.source_id)=(s.tenant_id,s.id)
   WHERE s.tenant_id=t AND s.room_id=r AND s.id IS DISTINCT FROM own_source AND a.kind<>'CLEAN' AND a.completed<a.quantity
   AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation e JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(e.tenant_id,e.request_id)
     WHERE e.tenant_id=t AND e.source_id=s.id AND q.state IN('CANCELLED','ROLLED_BACK')))
 AND NOT EXISTS(SELECT 1 FROM prsystem.stay s JOIN prsystem.reception_minibar_inspection i ON(i.tenant_id,i.stay_id)=(s.tenant_id,s.id)
   WHERE s.tenant_id=t AND s.room_id=r AND i.state<>'REPORTED')
 AND NOT EXISTS(SELECT 1 FROM prsystem.stay s JOIN prsystem.guest_payment_intent p ON(p.tenant_id,p.stay_id)=(s.tenant_id,s.id)
   WHERE s.tenant_id=t AND s.room_id=r AND p.state='PENDING')
 AND NOT EXISTS(SELECT 1 FROM prsystem.stay s JOIN prsystem.guest_correction p ON(p.tenant_id,p.stay_id)=(s.tenant_id,s.id)
   WHERE s.tenant_id=t AND s.room_id=r AND p.state='PENDING')
$$;

CREATE OR REPLACE FUNCTION prsystem.guard_minibar_configuration_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room prsystem.room%ROWTYPE; template prsystem.minibar_template%ROWTYPE;
 version prsystem.minibar_template_version%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable configuration history' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.state IN ('CANCELLED','APPLIED','ROLLED_BACK') OR NEW.state NOT IN ('CANCELLED','APPLIED','IN_PROGRESS','BLOCKED_VARIANCE','BLOCKED_STOCK','READY_FOR_RECONCILIATION','ROLLBACK_REQUIRED','ROLLED_BACK') OR NEW.revision<>OLD.revision+1
     OR (to_jsonb(NEW)-ARRAY['state','revision','cancelled_by','cancel_reason','cancelled_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','cancelled_by','cancel_reason','cancelled_at'])
   THEN RAISE EXCEPTION 'Invalid configuration transition' USING ERRCODE='23514'; END IF;
   IF OLD.state='ROLLBACK_REQUIRED' AND (NEW.state NOT IN('ROLLBACK_REQUIRED','ROLLED_BACK') OR
    (NEW.cancelled_by,NEW.cancel_reason,NEW.cancelled_at) IS DISTINCT FROM (OLD.cancelled_by,OLD.cancel_reason,OLD.cancelled_at))
   THEN RAISE EXCEPTION 'Rollback cannot resume or change cancellation evidence' USING ERRCODE='23514'; END IF;
   IF NEW.state='CANCELLED' AND EXISTS(SELECT 1 FROM prsystem.minibar_transfer WHERE tenant_id=NEW.tenant_id AND request_id=NEW.id)
   THEN RAISE EXCEPTION 'Posted movements require rollback' USING ERRCODE='23514'; END IF;
   IF NEW.state='ROLLBACK_REQUIRED' AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_rollback_request x WHERE x.tenant_id=NEW.tenant_id AND x.request_id=NEW.id AND x.actor_id=NEW.cancelled_by AND x.reason=NEW.cancel_reason)
   THEN RAISE EXCEPTION 'Rollback evidence required' USING ERRCODE='23514'; END IF;
   IF NEW.state='ROLLED_BACK' AND (OLD.state<>'ROLLBACK_REQUIRED' OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_execution_step x WHERE x.tenant_id=NEW.tenant_id AND x.request_id=NEW.id AND x.kind='ROLLBACK_COMPLETE' AND x.request_revision=OLD.revision))
   THEN RAISE EXCEPTION 'Completed physical rollback required' USING ERRCODE='23514'; END IF;
   IF NEW.state='READY_FOR_RECONCILIATION'  AND (OLD.request_kind NOT IN('ROLLOUT','NEXT_STAY') OR OLD.state<>'SCHEDULED_AFTER_STAY' OR NOT prsystem.minibar_safe_room(NEW.tenant_id,NEW.room_id,(SELECT source_id FROM prsystem.minibar_reconciliation WHERE tenant_id=NEW.tenant_id AND request_id=NEW.id))) THEN RAISE EXCEPTION 'Rollout safe point required' USING ERRCODE='23514'; END IF;
   IF NEW.state='APPLIED' THEN
     IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_application WHERE tenant_id=NEW.tenant_id AND request_id=NEW.id)
     THEN RAISE EXCEPTION 'Application proof required' USING ERRCODE='23514'; END IF;
   ELSIF NEW.state<>'CANCELLED' THEN
     IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation WHERE tenant_id=NEW.tenant_id AND request_id=NEW.id)
     THEN RAISE EXCEPTION 'Execution proof required' USING ERRCODE='23514'; END IF;
   END IF;
   IF NEW.state IN('CANCELLED','ROLLBACK_REQUIRED') AND OLD.state<>'ROLLBACK_REQUIRED' THEN NEW.cancelled_at:=clock_timestamp(); END IF;
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

CREATE FUNCTION prsystem.guard_minibar_rollback_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q prsystem.minibar_configuration_request%ROWTYPE;
BEGIN
 SELECT * INTO q FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 IF q.state NOT IN('IN_PROGRESS','BLOCKED_STOCK','BLOCKED_VARIANCE') OR NOT prsystem.minibar_variance_authorized(NEW.tenant_id,NEW.actor_id)
 OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_transfer WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id AND phase='PARTIAL')
 THEN RAISE EXCEPTION 'Rollback requires pending physical movement and Manager authority' USING ERRCODE='23514'; END IF;
 SELECT baseline INTO STRICT NEW.baseline FROM prsystem.minibar_reconciliation WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id;
 SELECT jsonb_agg(id ORDER BY id) INTO NEW.movement_ids FROM prsystem.minibar_transfer WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER minibar_rollback_request_guard BEFORE INSERT ON prsystem.minibar_rollback_request FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_rollback_request();
CREATE FUNCTION prsystem.guard_minibar_execution_step() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q prsystem.minibar_configuration_request%ROWTYPE; e prsystem.minibar_reconciliation%ROWTYPE; b jsonb;
BEGIN
 SELECT * INTO q FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 SELECT * INTO e FROM prsystem.minibar_reconciliation WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id;
 IF q.revision IS DISTINCT FROM NEW.request_revision OR NOT prsystem.minibar_safe_room(NEW.tenant_id,q.room_id,e.source_id)
 OR (NEW.kind='PARTIAL' AND q.state NOT IN('IN_PROGRESS','BLOCKED_STOCK','BLOCKED_VARIANCE'))
 OR (NEW.kind<>'PARTIAL' AND q.state<>'ROLLBACK_REQUIRED')
 OR NOT EXISTS(SELECT 1 FROM prsystem.cleaning_task t JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
 JOIN prsystem.staff_membership m ON(m.tenant_id,m.account_id)=(t.tenant_id,t.assignee_id)
 JOIN prsystem.staff_account a ON a.id=m.account_id JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id
 WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.task_id AND t.source_id=e.source_id AND t.assignee_id=NEW.actor_id
 AND t.assignment_version=NEW.assignment_version AND t.state='OPEN' AND w.state='OPEN'
 AND m.status='ACTIVE' AND 'CLEANER'=ANY(m.roles) AND a.status='ACTIVE' AND a.verified_at IS NOT NULL
 AND h.package_mnt>=25000 AND NOT h.security_suspended AND h.expires_at>clock_timestamp())
 THEN RAISE EXCEPTION 'Invalid current execution authority' USING ERRCODE='23514'; END IF;
 IF NEW.kind='ROLLBACK_COMPLETE' THEN
  IF (SELECT minibar_mode FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=q.room_id) IS DISTINCT FROM q.source_snapshot->>'mode'
  OR (SELECT minibar_application_id FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=q.room_id) IS DISTINCT FROM q.source_snapshot->>'application_id'
  OR (SELECT count(*) FROM jsonb_object_keys(NEW.observed_counts))<>jsonb_array_length(e.baseline) THEN RAISE EXCEPTION 'Original configuration changed' USING ERRCODE='23514'; END IF;
  FOR b IN SELECT * FROM jsonb_array_elements(e.baseline) LOOP
   IF (NEW.observed_counts->> (b->>'product_id'))::bigint IS DISTINCT FROM (b->>'quantity')::bigint
   OR prsystem.minibar_room_quantity(NEW.tenant_id,b->>'product_id',q.room_id) IS DISTINCT FROM (b->>'quantity')::bigint
   THEN RAISE EXCEPTION 'Rollback baseline count required' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 NEW.transaction_id:=pg_current_xact_id();NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER minibar_execution_step_guard BEFORE INSERT ON prsystem.minibar_execution_step FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_execution_step();
CREATE FUNCTION prsystem.prove_minibar_execution_step() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id AND revision>NEW.request_revision)
 OR (NEW.kind='ROLLBACK_COMPLETE' AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id AND state='ROLLED_BACK'))
 OR (NEW.kind<>'ROLLBACK_COMPLETE' AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_transfer WHERE tenant_id=NEW.tenant_id AND execution_step_id=NEW.id))
 THEN RAISE EXCEPTION 'Execution requires matching physical proof' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER minibar_execution_step_proof AFTER INSERT ON prsystem.minibar_execution_step DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_execution_step();


CREATE OR REPLACE FUNCTION prsystem.guard_minibar_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE req prsystem.minibar_configuration_request%ROWTYPE; total bigint; value numeric; denominator numeric; before_room bigint; before_wh bigint; target bigint;
BEGIN
 SELECT * INTO req FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 PERFORM 1 FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=req.room_id FOR UPDATE;
 PERFORM 1 FROM prsystem.minibar_product WHERE tenant_id=NEW.tenant_id AND id=NEW.product_id FOR UPDATE;
 IF (NEW.phase='ROLLBACK' AND req.state<>'ROLLBACK_REQUIRED') OR (NEW.phase='APPLY' AND req.state NOT IN ('IN_PROGRESS','BLOCKED_STOCK')) OR (NEW.phase='PARTIAL' AND req.state NOT IN ('IN_PROGRESS','BLOCKED_STOCK','BLOCKED_VARIANCE')) OR req.room_id IS DISTINCT FROM NEW.room_id
 OR NOT prsystem.minibar_safe_room(NEW.tenant_id,NEW.room_id,NEW.source_id) OR (NEW.phase<>'ROLLBACK' AND NOT prsystem.minibar_counts_match(NEW.tenant_id,req.id))
 OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation e JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(e.tenant_id,e.source_id)
 JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
 WHERE e.tenant_id=NEW.tenant_id AND e.request_id=req.id AND e.source_id=NEW.source_id AND t.id=NEW.task_id
 AND t.assignee_id=NEW.actor_id AND t.state='OPEN' AND w.state='OPEN')
 THEN RAISE EXCEPTION 'Invalid transfer source' USING ERRCODE='23514'; END IF;
 SELECT total_quantity_after,inventory_value_after,inventory_value_denominator INTO total,value,denominator FROM prsystem.minibar_receipt
 WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY stock_revision DESC LIMIT 1;
 before_room:=prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id,NEW.room_id);
 before_wh:=total-prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id);
 IF NEW.phase='PARTIAL' AND req.target_mode='ON' AND (
  NOT EXISTS(SELECT 1 FROM prsystem.room r JOIN prsystem.room_category c ON(c.tenant_id,c.id)=(r.tenant_id,r.category_id) WHERE r.tenant_id=NEW.tenant_id AND r.id=req.room_id AND r.status='ACTIVE' AND c.status='ACTIVE')
  OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_template t JOIN prsystem.minibar_template_version v ON(v.tenant_id,v.template_id)=(t.tenant_id,t.id) WHERE t.tenant_id=NEW.tenant_id AND t.id=req.target_template_id AND t.status='ACTIVE' AND v.id=req.target_version_id AND v.state='PUBLISHED')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(req.target_snapshot->'items') x LEFT JOIN prsystem.minibar_product p ON p.tenant_id=NEW.tenant_id AND p.id=x->>'product_id' WHERE p.status IS DISTINCT FROM 'ACTIVE'))
 THEN RAISE EXCEPTION 'Partial target lifecycle blocked' USING ERRCODE='23514'; END IF;
 IF NEW.phase<>'APPLY' AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_execution_step x JOIN prsystem.cleaning_task t ON(t.tenant_id,t.id)=(x.tenant_id,x.task_id)
 WHERE x.tenant_id=NEW.tenant_id AND x.id=NEW.execution_step_id AND x.request_id=req.id AND x.task_id=NEW.task_id AND x.actor_id=NEW.actor_id
 AND x.kind=NEW.phase AND x.request_revision=req.revision AND x.assignment_version=t.assignment_version
 AND (NEW.phase<>'ROLLBACK' OR (x.observed_counts->>NEW.product_id)::bigint=before_room))
 THEN RAISE EXCEPTION 'Current physical step proof required' USING ERRCODE='23514'; END IF;
 IF NEW.phase='ROLLBACK' THEN
  SELECT (b->>'quantity')::bigint INTO target FROM prsystem.minibar_rollback_request x,jsonb_array_elements(x.baseline) b
  WHERE x.tenant_id=NEW.tenant_id AND x.request_id=req.id AND b->>'product_id'=NEW.product_id;
 ELSE
 target:=prsystem.minibar_effective_target(NEW.tenant_id,req.id,NEW.product_id);
 END IF;
 IF target IS NULL THEN RAISE EXCEPTION 'Product outside rollback scope' USING ERRCODE='23514'; END IF;
 IF (NEW.direction='REFILL' AND (target<=before_room OR NEW.quantity>target-before_room OR (NEW.phase='APPLY' AND NEW.quantity<>target-before_room) OR NEW.quantity>before_wh))
 OR (NEW.direction='RETURN' AND (before_room<=target OR NEW.quantity>before_room-target OR (NEW.phase='APPLY' AND NEW.quantity<>before_room-target)))
 OR NEW.room_after<>before_room+(CASE WHEN NEW.direction='REFILL' THEN NEW.quantity ELSE -NEW.quantity END) OR NEW.warehouse_after<>before_wh+(CASE WHEN NEW.direction='RETURN' THEN NEW.quantity ELSE -NEW.quantity END)
 OR NEW.cost_value<>value OR NEW.cost_quantity<>total OR NEW.cost_denominator<>denominator
 THEN RAISE EXCEPTION 'Invalid bounded transfer' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.require_atomic_minibar_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.phase='APPLY' AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_application WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id)
 THEN RAISE EXCEPTION 'Partial configuration transfers cannot commit' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;

DO $$ DECLARE c text; BEGIN
 SELECT conname INTO STRICT c FROM pg_constraint WHERE conrelid='prsystem.minibar_count_resolution_posting'::regclass AND confrelid='prsystem.minibar_configuration_application'::regclass;
 EXECUTE format('ALTER TABLE prsystem.minibar_count_resolution_posting DROP CONSTRAINT %I',c);
END; $$;
ALTER TABLE prsystem.minibar_count_resolution_posting ADD FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_reconciliation;


CREATE OR REPLACE FUNCTION prsystem.prove_minibar_count_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v prsystem.minibar_count_resolution%ROWTYPE; delta bigint;
BEGIN
 SELECT * INTO STRICT v FROM prsystem.minibar_count_resolution WHERE tenant_id=NEW.tenant_id AND id=NEW.resolution_id;
 delta:=v.actual_count-v.physical_quantity;
 IF (NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_application a WHERE a.tenant_id=NEW.tenant_id AND a.request_id=v.request_id
 AND a.room_id=v.room_id AND a.source_id=v.source_id AND a.task_id=NEW.task_id AND a.actor_id=NEW.actor_id AND a.assignment_version=NEW.assignment_version)
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_transfer m JOIN prsystem.minibar_execution_step x ON(x.tenant_id,x.id)=(m.tenant_id,m.execution_step_id)
 WHERE m.tenant_id=NEW.tenant_id AND m.request_id=v.request_id AND m.phase='PARTIAL' AND m.source_id=v.source_id AND m.room_id=v.room_id
 AND m.task_id=NEW.task_id AND m.actor_id=NEW.actor_id AND x.assignment_version=NEW.assignment_version AND x.transaction_id=pg_current_xact_id()))
 OR(delta<>0 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_adjustment a JOIN prsystem.minibar_receipt r ON(r.tenant_id,r.id)=(a.tenant_id,a.receipt_id)
 WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.adjustment_id AND a.product_id=v.product_id AND a.room_id=v.room_id AND a.stay_id IS NULL
 AND a.quantity=abs(delta) AND a.hotel_delta=delta AND a.room_delta=delta AND a.billable_delta=0
 AND a.kind=(CASE WHEN v.kind='WASTE' THEN 'WASTE' WHEN delta>0 THEN 'COUNT_PLUS' ELSE 'COUNT_MINUS' END)
 AND a.actor_id=v.actor_id AND a.reason=v.reason AND r.stock_revision=v.stock_revision+1
 AND(v.unit_cost_mnt IS NULL OR(r.cost_numerator=v.unit_cost_mnt AND r.cost_denominator=1))))
 THEN RAISE EXCEPTION 'Count resolution requires atomic adjustment and application proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.minibar_shortage_plan(t text,request text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE q prsystem.minibar_configuration_request%ROWTYPE; e prsystem.minibar_reconciliation%ROWTYPE;
 room prsystem.room%ROWTYPE; b jsonb; lines jsonb:='[]'; target bigint; actual bigint; physical bigint;
 wh bigint; rev bigint; moved bigint; planned bigint; posting text; decision text; missing boolean:=false;
BEGIN
 SELECT * INTO q FROM prsystem.minibar_configuration_request WHERE tenant_id=t AND id=request;
 SELECT * INTO e FROM prsystem.minibar_reconciliation WHERE tenant_id=t AND request_id=request;
 SELECT * INTO room FROM prsystem.room WHERE tenant_id=t AND id=q.room_id;
 IF q.id IS NULL OR e.request_id IS NULL OR q.target_mode<>'ON' OR q.state NOT IN('IN_PROGRESS','BLOCKED_STOCK','BLOCKED_VARIANCE')
 OR room.status<>'ACTIVE' OR room.cleaning_state<>'CLEAN' OR NOT prsystem.minibar_safe_room(t,room.id,e.source_id)
 OR NOT EXISTS(SELECT 1 FROM prsystem.room_category WHERE tenant_id=t AND id=room.category_id AND status='ACTIVE')
 OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_template p JOIN prsystem.minibar_template_version v ON(v.tenant_id,v.template_id)=(p.tenant_id,p.id)
 WHERE p.tenant_id=t AND p.id=q.target_template_id AND p.status='ACTIVE' AND v.id=q.target_version_id AND v.state='PUBLISHED')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(q.target_snapshot->'items') x LEFT JOIN prsystem.minibar_product p ON p.tenant_id=t AND p.id=x->>'product_id' WHERE p.status IS DISTINCT FROM 'ACTIVE')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(prsystem.minibar_configuration_baseline(t,request)) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.baseline) baseline_item WHERE baseline_item->>'product_id'=x->>'product_id'))
 THEN RETURN NULL; END IF;
 FOR b IN SELECT * FROM jsonb_array_elements(e.baseline) LOOP
  SELECT p.actual_count,p.id INTO actual,posting FROM prsystem.cleaning_action a JOIN prsystem.cleaning_posting p
   ON(p.tenant_id,p.source_id,p.action_id)=(a.tenant_id,a.source_id,a.id)
   WHERE a.tenant_id=t AND a.source_id=e.source_id AND a.kind='COUNT' AND a.product_id=b->>'product_id';
  physical:=prsystem.minibar_room_quantity(t,b->>'product_id',room.id);
  SELECT v.id INTO decision FROM prsystem.minibar_count_resolution v WHERE v.tenant_id=t AND v.request_id=request
   AND v.product_id=b->>'product_id' AND prsystem.minibar_count_resolution_ready(t,v.id);
  SELECT coalesce(sum(CASE WHEN direction='REFILL' THEN quantity ELSE -quantity END),0) INTO moved FROM prsystem.minibar_transfer WHERE tenant_id=t AND request_id=request AND product_id=b->>'product_id';
  planned:=CASE WHEN decision IS NOT NULL THEN actual ELSE physical END;
  IF actual IS NULL OR actual NOT BETWEEN 0 AND 1000000 OR (decision IS NULL AND (actual+moved<>physical OR (actual<>(b->>'quantity')::bigint AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_count_resolution_posting z WHERE z.tenant_id=t AND z.request_id=request AND z.product_id=b->>'product_id')))) THEN RETURN NULL; END IF;
  SELECT stock_revision,total_quantity_after-prsystem.minibar_room_quantity(t,b->>'product_id') INTO rev,wh
   FROM prsystem.minibar_receipt WHERE tenant_id=t AND product_id=b->>'product_id' ORDER BY stock_revision DESC LIMIT 1;
  SELECT coalesce(sum((x->>'target_quantity')::bigint),0) INTO target FROM jsonb_array_elements(q.target_snapshot->'items') x WHERE x->>'product_id'=b->>'product_id';
  IF wh IS NULL OR wh<0 THEN RETURN NULL; END IF;
  missing:=missing OR target>planned+wh;
  lines:=lines||jsonb_build_array(jsonb_build_object('product_id',b->>'product_id','name',b->>'name','unit',b->>'unit',
   'baseline_quantity',(b->>'quantity')::bigint,'physical_quantity',physical,'actual_count',actual,'posting_id',posting,
   'resolution_id',decision,'stock_revision',rev,'warehouse_quantity',wh,'target_quantity',target,'approved_quantity',least(target,planned+wh)));
 END LOOP;
 IF NOT missing THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('room_id',room.id,'room_revision',room.revision,'source_id',e.source_id,'target',q.target_snapshot,
  'prior_stay_id',(SELECT id FROM prsystem.stay WHERE tenant_id=t AND room_id=room.id ORDER BY check_in_recorded_at DESC,id DESC LIMIT 1),'lines',lines);
END; $$;

-- Once physical work has committed, new count variance needs compensating review.
CREATE OR REPLACE FUNCTION prsystem.guard_minibar_count_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q prsystem.minibar_configuration_request%ROWTYPE; e prsystem.minibar_reconciliation%ROWTYPE;
 p prsystem.cleaning_posting%ROWTYPE; b bigint; rev bigint; total bigint;
BEGIN
 SELECT * INTO q FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 SELECT * INTO e FROM prsystem.minibar_reconciliation WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id;
 SELECT * INTO p FROM prsystem.cleaning_posting WHERE id=NEW.posting_id;
 SELECT (x->>'quantity')::bigint INTO b FROM jsonb_array_elements(e.baseline) x WHERE x->>'product_id'=NEW.product_id;
 SELECT stock_revision,total_quantity_after INTO rev,total FROM prsystem.minibar_receipt WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY stock_revision DESC LIMIT 1;
 IF EXISTS(SELECT 1 FROM prsystem.minibar_transfer WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id AND phase='PARTIAL') OR q.id IS NULL OR e.source_id IS DISTINCT FROM NEW.source_id OR q.room_id IS DISTINCT FROM NEW.room_id
 OR q.state NOT IN('IN_PROGRESS','BLOCKED_VARIANCE','BLOCKED_STOCK') OR q.revision<>NEW.request_revision
 OR NOT prsystem.minibar_variance_authorized(NEW.tenant_id,NEW.actor_id)
 OR NOT prsystem.minibar_safe_room(NEW.tenant_id,NEW.room_id,NEW.source_id)
 OR p.tenant_id IS DISTINCT FROM NEW.tenant_id OR p.source_id IS DISTINCT FROM NEW.source_id
 OR p.actual_count IS DISTINCT FROM NEW.actual_count OR b IS DISTINCT FROM NEW.baseline_quantity
 OR NOT EXISTS(SELECT 1 FROM prsystem.cleaning_action a WHERE a.tenant_id=NEW.tenant_id AND a.source_id=NEW.source_id
 AND a.id=p.action_id AND a.kind='COUNT' AND a.product_id=NEW.product_id)
 OR EXISTS(SELECT 1 FROM prsystem.cleaning_action WHERE tenant_id=NEW.tenant_id AND source_id=NEW.source_id AND completed<quantity)
 OR rev IS DISTINCT FROM NEW.stock_revision OR NEW.physical_quantity<>prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id,NEW.room_id)
 OR(NEW.actual_count=NEW.baseline_quantity AND NEW.actual_count=NEW.physical_quantity)
 OR(NEW.kind='WASTE' AND NEW.actual_count>=NEW.physical_quantity)
 OR((NEW.actual_count>NEW.physical_quantity AND total=0) IS DISTINCT FROM (NEW.unit_cost_mnt IS NOT NULL))
 THEN RAISE EXCEPTION 'Invalid count variance decision' USING ERRCODE='23514'; END IF;
 SELECT coalesce(nullif(display_name,''),email) INTO NEW.actor_label FROM prsystem.staff_account WHERE id=NEW.actor_id;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
