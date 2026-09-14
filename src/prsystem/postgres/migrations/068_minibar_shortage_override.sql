-- Controlled SHORT opening: reviewed counts, atomic configuration and one next stay.
CREATE TABLE prsystem.minibar_shortage_approval (
 tenant_id text NOT NULL,id text NOT NULL,request_id text NOT NULL,request_revision bigint NOT NULL,
 plan jsonb NOT NULL,actor_id text NOT NULL,actor_label text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id,request_revision),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_reconciliation,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TABLE prsystem.minibar_shortage_posting (
 tenant_id text NOT NULL,request_id text NOT NULL,approval_id text NOT NULL,task_id text NOT NULL,
 actor_id text NOT NULL,assignment_version bigint NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id),UNIQUE(tenant_id,approval_id),
 FOREIGN KEY(tenant_id,approval_id) REFERENCES prsystem.minibar_shortage_approval,
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_configuration_application DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,task_id) REFERENCES prsystem.cleaning_task,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TABLE prsystem.minibar_shortage_permit (
 tenant_id text NOT NULL,id text NOT NULL,room_id text NOT NULL,room_revision bigint NOT NULL,
 inventory_stamp jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,id) REFERENCES prsystem.minibar_shortage_posting(tenant_id,approval_id),
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room
);
CREATE TABLE prsystem.minibar_shortage_use (
 tenant_id text NOT NULL,permit_id text NOT NULL,stay_id text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,permit_id),UNIQUE(tenant_id,stay_id),
 FOREIGN KEY(tenant_id,permit_id) REFERENCES prsystem.minibar_shortage_permit,
 FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay DEFERRABLE INITIALLY DEFERRED
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_shortage_approval','minibar_shortage_posting','minibar_shortage_permit','minibar_shortage_use'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;

-- No cost or selling price in the physical approval. Every baseline product is reviewed.
CREATE FUNCTION prsystem.minibar_shortage_plan(t text,request text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE q prsystem.minibar_configuration_request%ROWTYPE; e prsystem.minibar_reconciliation%ROWTYPE;
 room prsystem.room%ROWTYPE; b jsonb; lines jsonb:='[]'; target bigint; actual bigint; physical bigint;
 wh bigint; rev bigint; posting text; decision text; missing boolean:=false;
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
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(prsystem.minibar_configuration_baseline(t,request)) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.baseline) b WHERE b->>'product_id'=x->>'product_id'))
 THEN RETURN NULL; END IF;
 FOR b IN SELECT * FROM jsonb_array_elements(e.baseline) LOOP
  SELECT p.actual_count,p.id INTO actual,posting FROM prsystem.cleaning_action a JOIN prsystem.cleaning_posting p
   ON(p.tenant_id,p.source_id,p.action_id)=(a.tenant_id,a.source_id,a.id)
   WHERE a.tenant_id=t AND a.source_id=e.source_id AND a.kind='COUNT' AND a.product_id=b->>'product_id';
  physical:=prsystem.minibar_room_quantity(t,b->>'product_id',room.id);
  SELECT v.id INTO decision FROM prsystem.minibar_count_resolution v WHERE v.tenant_id=t AND v.request_id=request
   AND v.product_id=b->>'product_id' AND prsystem.minibar_count_resolution_ready(t,v.id);
  IF actual IS NULL OR actual NOT BETWEEN 0 AND 1000000 OR (decision IS NULL AND (actual<>physical OR actual<>(b->>'quantity')::bigint)) THEN RETURN NULL; END IF;
  SELECT stock_revision,total_quantity_after-prsystem.minibar_room_quantity(t,b->>'product_id') INTO rev,wh
   FROM prsystem.minibar_receipt WHERE tenant_id=t AND product_id=b->>'product_id' ORDER BY stock_revision DESC LIMIT 1;
  SELECT coalesce(sum((x->>'target_quantity')::bigint),0) INTO target FROM jsonb_array_elements(q.target_snapshot->'items') x WHERE x->>'product_id'=b->>'product_id';
  IF wh IS NULL OR wh<0 THEN RETURN NULL; END IF;
  missing:=missing OR target>actual+wh;
  lines:=lines||jsonb_build_array(jsonb_build_object('product_id',b->>'product_id','name',b->>'name','unit',b->>'unit',
   'baseline_quantity',(b->>'quantity')::bigint,'physical_quantity',physical,'actual_count',actual,'posting_id',posting,
   'resolution_id',decision,'stock_revision',rev,'warehouse_quantity',wh,'target_quantity',target,'approved_quantity',least(target,actual+wh)));
 END LOOP;
 IF NOT missing THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('room_id',room.id,'room_revision',room.revision,'source_id',e.source_id,'target',q.target_snapshot,
  'prior_stay_id',(SELECT id FROM prsystem.stay WHERE tenant_id=t AND room_id=room.id ORDER BY check_in_recorded_at DESC,id DESC LIMIT 1),'lines',lines);
END; $$;
CREATE FUNCTION prsystem.guard_minibar_shortage_approval() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_plan jsonb; rev bigint;
BEGIN
 SELECT revision INTO rev FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 PERFORM 1 FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id
 WHERE m.tenant_id=NEW.tenant_id AND m.account_id=NEW.actor_id FOR SHARE OF m,a,h;
 current_plan:=prsystem.minibar_shortage_plan(NEW.tenant_id,NEW.request_id);
 IF current_plan IS NULL OR current_plan IS DISTINCT FROM NEW.plan OR rev IS DISTINCT FROM NEW.request_revision
 OR NOT prsystem.minibar_variance_authorized(NEW.tenant_id,NEW.actor_id)
 THEN RAISE EXCEPTION 'Invalid shortage approval' USING ERRCODE='23514'; END IF;
 SELECT coalesce(nullif(display_name,''),email) INTO NEW.actor_label FROM prsystem.staff_account WHERE id=NEW.actor_id;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER shortage_approval_guard BEFORE INSERT ON prsystem.minibar_shortage_approval FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_shortage_approval();
CREATE FUNCTION prsystem.minibar_shortage_approval_ready(t text,approval text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM prsystem.minibar_shortage_approval a JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(a.tenant_id,a.request_id)
 WHERE a.tenant_id=t AND a.id=approval AND q.revision=a.request_revision+1
 AND prsystem.minibar_variance_authorized(t,a.actor_id) AND a.plan=prsystem.minibar_shortage_plan(t,a.request_id))
$$;
CREATE FUNCTION prsystem.guard_minibar_shortage_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a prsystem.minibar_shortage_approval%ROWTYPE;
BEGIN
 SELECT * INTO a FROM prsystem.minibar_shortage_approval WHERE tenant_id=NEW.tenant_id AND id=NEW.approval_id;
 PERFORM 1 FROM prsystem.staff_membership m JOIN prsystem.staff_account x ON x.id=m.account_id JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id
 WHERE m.tenant_id=NEW.tenant_id AND m.account_id=a.actor_id FOR SHARE OF m,x,h;
 IF a.request_id IS DISTINCT FROM NEW.request_id OR NOT prsystem.minibar_shortage_approval_ready(NEW.tenant_id,a.id)
 OR NOT EXISTS(SELECT 1 FROM prsystem.cleaning_task t JOIN prsystem.staff_open_work w ON(w.tenant_id,w.source_id)=(t.tenant_id,t.id) AND w.kind='CLEANING_TASK'
 WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.task_id AND t.source_id=a.plan->>'source_id' AND t.assignee_id=NEW.actor_id
 AND t.assignment_version=NEW.assignment_version AND t.state='OPEN' AND w.state='OPEN')
 THEN RAISE EXCEPTION 'Stale shortage approval or assignment' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER shortage_posting_guard BEFORE INSERT ON prsystem.minibar_shortage_posting FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_shortage_posting();
CREATE FUNCTION prsystem.minibar_effective_target(t text,request text,product text) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT coalesce((SELECT (x->>'approved_quantity')::bigint FROM prsystem.minibar_shortage_posting s
 JOIN prsystem.minibar_shortage_approval a ON(a.tenant_id,a.id)=(s.tenant_id,s.approval_id),jsonb_array_elements(a.plan->'lines') x
 WHERE s.tenant_id=t AND s.request_id=request AND x->>'product_id'=product),
 (SELECT coalesce(sum((x->>'target_quantity')::bigint),0)::bigint FROM prsystem.minibar_configuration_request q,
 jsonb_array_elements(q.target_snapshot->'items') x WHERE q.tenant_id=t AND q.id=request AND x->>'product_id'=product))
$$;

CREATE OR REPLACE FUNCTION prsystem.guard_minibar_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE req prsystem.minibar_configuration_request%ROWTYPE; total bigint; value numeric; denominator numeric; before_room bigint; before_wh bigint; target bigint;
BEGIN
 SELECT * INTO req FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 PERFORM 1 FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=req.room_id FOR UPDATE;
 PERFORM 1 FROM prsystem.minibar_product WHERE tenant_id=NEW.tenant_id AND id=NEW.product_id FOR UPDATE;
 IF req.state NOT IN ('IN_PROGRESS','BLOCKED_STOCK') OR req.room_id IS DISTINCT FROM NEW.room_id
 OR NOT prsystem.minibar_safe_room(NEW.tenant_id,NEW.room_id,NEW.source_id) OR NOT prsystem.minibar_counts_match(NEW.tenant_id,req.id)
 OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation e JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(e.tenant_id,e.source_id)
 JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
 WHERE e.tenant_id=NEW.tenant_id AND e.request_id=req.id AND e.source_id=NEW.source_id AND t.id=NEW.task_id
 AND t.assignee_id=NEW.actor_id AND t.state='OPEN' AND w.state='OPEN')
 THEN RAISE EXCEPTION 'Invalid transfer source' USING ERRCODE='23514'; END IF;
 SELECT total_quantity_after,inventory_value_after,inventory_value_denominator INTO total,value,denominator FROM prsystem.minibar_receipt
 WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY stock_revision DESC LIMIT 1;
 before_room:=prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id,NEW.room_id);
 before_wh:=total-prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id);
 target:=prsystem.minibar_effective_target(NEW.tenant_id,req.id,NEW.product_id);
 IF (NEW.direction='REFILL' AND (target<=before_room OR NEW.quantity<>target-before_room OR NEW.quantity>before_wh))
 OR (NEW.direction='RETURN' AND (before_room<=target OR NEW.quantity<>before_room-target))
 OR NEW.room_after<>target OR NEW.warehouse_after<>before_wh+(CASE WHEN NEW.direction='RETURN' THEN NEW.quantity ELSE -NEW.quantity END)
 OR NEW.cost_value<>value OR NEW.cost_quantity<>total OR NEW.cost_denominator<>denominator
 THEN RAISE EXCEPTION 'Invalid bounded transfer' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.guard_minibar_application() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE req prsystem.minibar_configuration_request%ROWTYPE; item jsonb; target bigint;
BEGIN
 SELECT * INTO req FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 PERFORM 1 FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=req.room_id FOR UPDATE;
 IF req.state NOT IN ('IN_PROGRESS','BLOCKED_STOCK') OR req.room_id IS DISTINCT FROM NEW.room_id
 OR NOT prsystem.minibar_counts_match(NEW.tenant_id,req.id) OR NOT prsystem.minibar_safe_room(NEW.tenant_id,NEW.room_id,NEW.source_id)
 OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation e JOIN prsystem.cleaning_task t ON(t.tenant_id,t.source_id)=(e.tenant_id,e.source_id)
 JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
 WHERE e.tenant_id=NEW.tenant_id AND e.request_id=req.id AND e.source_id=NEW.source_id AND t.id=NEW.task_id
 AND t.assignee_id=NEW.actor_id AND t.assignment_version=NEW.assignment_version AND t.state='OPEN' AND w.state='OPEN')
 THEN RAISE EXCEPTION 'Invalid application source' USING ERRCODE='23514'; END IF;
 IF req.target_mode='ON' THEN
   PERFORM 1 FROM prsystem.minibar_template t JOIN prsystem.minibar_template_version v ON(v.tenant_id,v.template_id)=(t.tenant_id,t.id)
   WHERE t.tenant_id=NEW.tenant_id AND t.id=req.target_template_id AND v.id=req.target_version_id AND t.status='ACTIVE' AND v.state='PUBLISHED' FOR SHARE OF t,v;
   IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM prsystem.room r JOIN prsystem.room_category c ON(c.tenant_id,c.id)=(r.tenant_id,r.category_id)
     WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.room_id AND r.status='ACTIVE' AND c.status='ACTIVE')
   THEN RAISE EXCEPTION 'Target lifecycle blocked' USING ERRCODE='23514'; END IF;
   FOR item IN SELECT * FROM jsonb_array_elements(req.target_snapshot->'items') LOOP
     PERFORM 1 FROM prsystem.minibar_product WHERE tenant_id=NEW.tenant_id AND id=item->>'product_id' AND status='ACTIVE' FOR SHARE;
     IF NOT FOUND THEN RAISE EXCEPTION 'Target product blocked' USING ERRCODE='23514'; END IF;
   END LOOP;
 END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(prsystem.minibar_configuration_baseline(NEW.tenant_id,req.id)) LOOP
   target:=prsystem.minibar_effective_target(NEW.tenant_id,req.id,item->>'product_id');
   IF (item->>'quantity')::bigint<>target THEN RAISE EXCEPTION 'Room balance does not match target' USING ERRCODE='23514'; END IF;
 END LOOP;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;

-- Room-local immutable movement counts detect changes even when net quantity returns
-- to the same value. Unrelated warehouse purchases do not invalidate a counted room.
CREATE FUNCTION prsystem.minibar_room_inventory_stamp(t text,r text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object(
 'transfers',(SELECT count(*) FROM prsystem.minibar_transfer WHERE tenant_id=t AND room_id=r),
 'receipts',(SELECT count(*) FROM prsystem.minibar_receipt WHERE tenant_id=t AND room_id=r),
 'adjustments',(SELECT count(*) FROM prsystem.minibar_adjustment WHERE tenant_id=t AND room_id=r),
 'refills',(SELECT count(*) FROM prsystem.minibar_refill_result x JOIN prsystem.minibar_refill_request q ON(q.tenant_id,q.id)=(x.tenant_id,x.request_id) WHERE q.tenant_id=t AND q.room_id=r AND x.state='COMPLETED'))
$$;
CREATE FUNCTION prsystem.guard_minibar_shortage_permit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a prsystem.minibar_shortage_approval%ROWTYPE; room prsystem.room%ROWTYPE;
BEGIN
 SELECT * INTO a FROM prsystem.minibar_shortage_approval WHERE tenant_id=NEW.tenant_id AND id=NEW.id;
 SELECT * INTO room FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=a.plan->>'room_id' FOR UPDATE;
 IF a.id IS NULL OR NEW.room_id IS DISTINCT FROM room.id OR room.minibar_application_id IS DISTINCT FROM a.request_id
 OR room.revision<>(a.plan->>'room_revision')::bigint+1 OR room.cleaning_state<>'CLEAN'
 OR NOT prsystem.minibar_variance_authorized(NEW.tenant_id,a.actor_id)
 OR NOT prsystem.minibar_safe_room(NEW.tenant_id,room.id,a.plan->>'source_id')
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(a.plan->'lines') x WHERE prsystem.minibar_room_quantity(NEW.tenant_id,x->>'product_id',room.id)<>(x->>'approved_quantity')::bigint)
 OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_application app JOIN prsystem.minibar_shortage_posting s ON(s.tenant_id,s.request_id)=(app.tenant_id,app.request_id)
 WHERE s.tenant_id=NEW.tenant_id AND s.approval_id=NEW.id AND(app.task_id,app.actor_id,app.assignment_version)=(s.task_id,s.actor_id,s.assignment_version))
 THEN RAISE EXCEPTION 'Shortage permit requires completed physical application' USING ERRCODE='23514'; END IF;
 NEW.room_revision:=room.revision;NEW.inventory_stamp:=prsystem.minibar_room_inventory_stamp(NEW.tenant_id,room.id);
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER shortage_permit_guard BEFORE INSERT ON prsystem.minibar_shortage_permit FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_shortage_permit();
CREATE FUNCTION prsystem.prove_minibar_shortage_posting() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_shortage_permit WHERE tenant_id=NEW.tenant_id AND id=NEW.approval_id)
 THEN RAISE EXCEPTION 'Shortage application requires next-stay permit' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER shortage_posting_proof AFTER INSERT ON prsystem.minibar_shortage_posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_shortage_posting();
CREATE FUNCTION prsystem.minibar_shortage_permit_ready(t text,permit text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM prsystem.minibar_shortage_permit p JOIN prsystem.minibar_shortage_approval a ON(a.tenant_id,a.id)=(p.tenant_id,p.id)
 JOIN prsystem.room r ON(r.tenant_id,r.id)=(p.tenant_id,p.room_id)
 WHERE p.tenant_id=t AND p.id=permit AND r.minibar_application_id=a.request_id AND r.minibar_mode='ON'
 AND r.revision=p.room_revision AND r.status='ACTIVE' AND r.cleaning_state='CLEAN'
 AND p.inventory_stamp=prsystem.minibar_room_inventory_stamp(t,r.id)
 AND prsystem.minibar_variance_authorized(t,a.actor_id) AND prsystem.minibar_booking_eligible(t,r.id)
 AND prsystem.minibar_safe_room(t,r.id)
 AND a.plan->>'prior_stay_id' IS NOT DISTINCT FROM(SELECT id FROM prsystem.stay WHERE tenant_id=t AND room_id=r.id ORDER BY check_in_recorded_at DESC,id DESC LIMIT 1)
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_shortage_use WHERE tenant_id=t AND permit_id=p.id)
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(a.plan->'lines') x WHERE prsystem.minibar_room_quantity(t,x->>'product_id',r.id)<>(x->>'approved_quantity')::bigint))
$$;
CREATE FUNCTION prsystem.minibar_shortage_room(t text,r text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('permit_id',p.id,'request_id',a.request_id,'actor_id',a.actor_id,'actor_label',a.actor_label,
 'reason',a.reason,'recorded_at',a.recorded_at,'ready',prsystem.minibar_shortage_permit_ready(t,p.id),
 'used_stay_id',(SELECT stay_id FROM prsystem.minibar_shortage_use WHERE tenant_id=t AND permit_id=p.id),
 'target',a.plan->'target','lines',a.plan->'lines')
 FROM prsystem.minibar_shortage_permit p JOIN prsystem.minibar_shortage_approval a ON(a.tenant_id,a.id)=(p.tenant_id,p.id)
 JOIN prsystem.room room ON(room.tenant_id,room.id,room.minibar_application_id)=(p.tenant_id,p.room_id,a.request_id)
 WHERE p.tenant_id=t AND p.room_id=r
$$;

CREATE OR REPLACE FUNCTION prsystem.minibar_guest_opening(t text,r text,recorded timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE req prsystem.minibar_configuration_request%ROWTYPE; result jsonb; lines jsonb; shortage jsonb;
BEGIN
 SELECT q.* INTO req FROM prsystem.room room JOIN prsystem.minibar_configuration_request q
 ON(q.tenant_id,q.id)=(room.tenant_id,room.minibar_application_id)
 JOIN prsystem.minibar_configuration_application a ON(a.tenant_id,a.request_id)=(q.tenant_id,q.id)
 JOIN prsystem.minibar_template p ON(p.tenant_id,p.id)=(q.tenant_id,q.target_template_id)
 JOIN prsystem.minibar_template_version v ON(v.tenant_id,v.template_id,v.id)=(q.tenant_id,q.target_template_id,q.target_version_id)
 WHERE room.tenant_id=t AND room.id=r AND room.minibar_mode='ON' AND q.state='APPLIED'
 AND p.status='ACTIVE' AND v.state='PUBLISHED';
 IF NOT FOUND OR EXISTS(SELECT 1 FROM prsystem.reception_dependency_blocker
  WHERE tenant_id=t AND room_id=r AND state='OPEN' AND source_kind<>'CANONICAL_MINIBAR')
 OR NOT EXISTS(SELECT 1 FROM prsystem.hotel_access WHERE tenant_id=t AND package_mnt IN(25000,30000))
 THEN RETURN NULL; END IF;
 -- Full stock remains the normal gate; only an unused exact permit can admit SHORT.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(req.target_snapshot->'items') x LEFT JOIN prsystem.minibar_product p
 ON p.tenant_id=t AND p.id=x->>'product_id' WHERE p.status IS DISTINCT FROM 'ACTIVE'
 )
 OR EXISTS(SELECT 1 FROM prsystem.minibar_product p WHERE p.tenant_id=t AND prsystem.minibar_room_quantity(t,p.id,r)<>0
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(req.target_snapshot->'items') x WHERE x->>'product_id'=p.id))
 THEN RETURN NULL; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(req.target_snapshot->'items') x WHERE prsystem.minibar_room_quantity(t,x->>'product_id',r) IS DISTINCT FROM (x->>'target_quantity')::bigint) THEN
  shortage:=prsystem.minibar_shortage_room(t,r);
  IF shortage IS NULL OR shortage->>'ready' IS DISTINCT FROM 'true' THEN RETURN NULL; END IF;
 END IF;
 SELECT jsonb_agg(jsonb_build_object('product_id',p.id,'name',p.name,'category',p.category,'unit',p.unit,
  'unit_price',p.selling_price_mnt,'product_revision',p.revision,'target_quantity',(x->>'target_quantity')::bigint,
  'opening_quantity',prsystem.minibar_room_quantity(t,p.id,r)) ORDER BY p.id) INTO lines
 FROM jsonb_array_elements(req.target_snapshot->'items') x JOIN prsystem.minibar_product p ON p.tenant_id=t AND p.id=x->>'product_id';
 IF lines IS NULL THEN RETURN NULL; END IF;
 RETURN (req.target_snapshot-'items')||jsonb_build_object('mode','CANONICAL','application_id',req.id,'recorded_at',recorded,'items',lines)||CASE WHEN shortage IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('stock_status','SHORT','shortage_permit_id',shortage->>'permit_id','shortage_approval',shortage-ARRAY['ready','used_stay_id']) END;
END; $$;

CREATE FUNCTION prsystem.guard_minibar_shortage_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM prsystem.minibar_shortage_permit p JOIN prsystem.room r ON(r.tenant_id,r.id)=(p.tenant_id,p.room_id)
 WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.permit_id FOR UPDATE OF r;
 PERFORM 1 FROM prsystem.minibar_shortage_approval a JOIN prsystem.staff_membership m ON(m.tenant_id,m.account_id)=(a.tenant_id,a.actor_id)
 JOIN prsystem.staff_account s ON s.id=m.account_id JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id
 WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.permit_id FOR SHARE OF m,s,h;
 IF NOT prsystem.minibar_shortage_permit_ready(NEW.tenant_id,NEW.permit_id)
 THEN RAISE EXCEPTION 'Shortage permit is stale or already used' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER shortage_use_guard BEFORE INSERT ON prsystem.minibar_shortage_use FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_shortage_use();
CREATE FUNCTION prsystem.prove_minibar_shortage_use() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.stay s JOIN prsystem.minibar_shortage_permit p ON(p.tenant_id,p.room_id)=(s.tenant_id,s.room_id)
 WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.stay_id AND p.id=NEW.permit_id
 AND s.snapshot->'minibar_snapshot'->>'shortage_permit_id'=NEW.permit_id AND s.snapshot->'minibar_snapshot'->>'stock_status'='SHORT')
 THEN RAISE EXCEPTION 'Shortage use requires matching immutable stay opening' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER shortage_use_proof AFTER INSERT ON prsystem.minibar_shortage_use DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_shortage_use();

CREATE OR REPLACE FUNCTION prsystem.guard_minibar_stay_opening() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode text; opening jsonb;
BEGIN
 SELECT minibar_mode INTO mode FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
 IF mode='ON' OR NEW.snapshot->>'minibar_mode'='ON' THEN
  opening:=prsystem.minibar_guest_opening(NEW.tenant_id,NEW.room_id,NEW.check_in_recorded_at);
  IF mode IS DISTINCT FROM 'ON' OR NEW.snapshot->>'minibar_mode' IS DISTINCT FROM 'ON'
   OR opening IS NULL OR NEW.snapshot->'minibar_snapshot' IS DISTINCT FROM opening
  THEN RAISE EXCEPTION 'Canonical minibar opening required' USING ERRCODE='23514'; END IF;
  NEW.minibar_application_id:=opening->>'application_id';
  IF opening->>'shortage_permit_id' IS NOT NULL THEN
   INSERT INTO prsystem.minibar_shortage_use(tenant_id,permit_id,stay_id) VALUES(NEW.tenant_id,opening->>'shortage_permit_id',NEW.id);
  END IF;
 ELSIF NEW.minibar_application_id IS NOT NULL THEN
  RAISE EXCEPTION 'Unexpected minibar application' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
