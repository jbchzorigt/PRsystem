-- Immutable stay-scoped request and physical completion. No guest price in tasks.
ALTER TABLE prsystem.minibar_product ADD COLUMN deactivation_requested_at timestamptz;
ALTER TABLE prsystem.minibar_product DROP CONSTRAINT minibar_product_status_check;
ALTER TABLE prsystem.minibar_product ADD CHECK(status IN('ACTIVE','RETIRING','INACTIVE'));
CREATE TABLE prsystem.minibar_refill_request (
 tenant_id text NOT NULL,id text NOT NULL,stay_id text NOT NULL,room_id text NOT NULL,product_id text NOT NULL,
 source_id text NOT NULL,requester_id text NOT NULL,quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),
 product_snapshot jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,source_id),
 FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay,
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room,
 FOREIGN KEY(tenant_id,product_id) REFERENCES prsystem.minibar_product,
 FOREIGN KEY(tenant_id,source_id) REFERENCES prsystem.cleaning_source,
 FOREIGN KEY(tenant_id,requester_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TABLE prsystem.minibar_refill_result (
 tenant_id text NOT NULL,request_id text NOT NULL,state text NOT NULL CHECK(state IN('COMPLETED','CANCELLED','UNAVAILABLE')),
 actor_id text NOT NULL,task_id text,assignment_version bigint,quantity bigint NOT NULL CHECK(quantity BETWEEN 0 AND 1000000),
 reason text,warehouse_after bigint,room_after bigint,cost_value numeric,cost_denominator numeric,cost_quantity bigint,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_refill_request,
 FOREIGN KEY(tenant_id,task_id) REFERENCES prsystem.cleaning_task,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 CHECK((state='COMPLETED' AND quantity>0 AND warehouse_after>=0 AND room_after BETWEEN quantity AND 1000000
  AND cost_value>=0 AND cost_value=trunc(cost_value) AND cost_denominator>=1 AND cost_denominator=trunc(cost_denominator)
  AND cost_quantity>0 AND reason IS NULL AND task_id IS NOT NULL AND assignment_version>=0)
 OR(state<>'COMPLETED' AND quantity=0 AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 1000
  AND warehouse_after IS NULL AND room_after IS NULL AND cost_value IS NULL AND cost_denominator IS NULL AND cost_quantity IS NULL)),
 CHECK(state='CANCELLED' OR(task_id IS NOT NULL AND assignment_version IS NOT NULL))
);
CREATE INDEX minibar_refill_stay ON prsystem.minibar_refill_request(tenant_id,stay_id,id);

CREATE OR REPLACE FUNCTION prsystem.minibar_room_quantity(t text,p text,r text DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT (coalesce((SELECT sum(CASE WHEN direction='REFILL' THEN quantity ELSE -quantity END)
 FROM prsystem.minibar_transfer WHERE tenant_id=t AND product_id=p AND(r IS NULL OR room_id=r)),0)
 +coalesce((SELECT sum(quantity) FROM prsystem.minibar_receipt WHERE tenant_id=t AND product_id=p
 AND kind IN('CONSUMPTION','CONSUMPTION_REVERSAL') AND(r IS NULL OR room_id=r)),0)
 +coalesce((SELECT sum(x.quantity) FROM prsystem.minibar_refill_result x JOIN prsystem.minibar_refill_request q
 ON(q.tenant_id,q.id)=(x.tenant_id,x.request_id) WHERE q.tenant_id=t AND q.product_id=p
 AND x.state='COMPLETED' AND(r IS NULL OR q.room_id=r)),0))::bigint
$$;
CREATE FUNCTION prsystem.minibar_stay_availability(t text,s text,p text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('available_quantity',(item->>'opening_quantity')::bigint+coalesce(sum(x.quantity),0),
  'refill_quantity',coalesce(sum(x.quantity),0),'refill_ids',coalesce(jsonb_agg(q.id ORDER BY q.id) FILTER(WHERE x.request_id IS NOT NULL),'[]'::jsonb),
  'inventory_cutoff_at',intent.recorded_at)
 FROM prsystem.stay st CROSS JOIN LATERAL jsonb_array_elements(st.snapshot->'minibar_snapshot'->'items') item
 LEFT JOIN prsystem.reception_checkout_intent intent ON(intent.tenant_id,intent.stay_id)=(st.tenant_id,st.id)
 LEFT JOIN prsystem.minibar_refill_request q ON q.tenant_id=t AND q.stay_id=s AND q.product_id=p
 LEFT JOIN prsystem.minibar_refill_result x ON(x.tenant_id,x.request_id)=(q.tenant_id,q.id)
 AND x.state='COMPLETED' AND(intent.recorded_at IS NULL OR x.recorded_at<=intent.recorded_at)
 WHERE st.tenant_id=t AND st.id=s AND item->>'product_id'=p GROUP BY item,intent.recorded_at
$$;

CREATE FUNCTION prsystem.guard_minibar_refill_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st prsystem.stay%ROWTYPE; src prsystem.cleaning_source%ROWTYPE; line jsonb; product_status text;
BEGIN
 PERFORM id FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
 SELECT * INTO st FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND id=NEW.stay_id FOR UPDATE;
 SELECT * INTO src FROM prsystem.cleaning_source WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id;
 SELECT x INTO line FROM jsonb_array_elements(st.snapshot->'minibar_snapshot'->'items') x WHERE x->>'product_id'=NEW.product_id;
 SELECT p.status INTO product_status FROM prsystem.minibar_product p WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.product_id FOR UPDATE;
 IF st.state IS DISTINCT FROM 'ACTIVE' OR st.room_id IS DISTINCT FROM NEW.room_id OR st.snapshot->>'minibar_mode' IS DISTINCT FROM 'ON'
 OR line IS NULL OR product_status IS DISTINCT FROM 'ACTIVE'
 OR NOT EXISTS(SELECT 1 FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id AND status IN('ACTIVE','RETIRING'))
 OR EXISTS(SELECT 1 FROM prsystem.reception_checkout_intent WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id)
 OR src.source_kind IS DISTINCT FROM 'REFILL' OR src.room_id IS DISTINCT FROM NEW.room_id
 OR src.source_reference IS DISTINCT FROM 'minibar-refill:'||NEW.id
 OR NEW.product_snapshot IS DISTINCT FROM jsonb_build_object('product_id',NEW.product_id,'name',line->>'name','unit',line->>'unit')
 OR src.snapshot IS DISTINCT FROM jsonb_build_object('canonical_minibar',true,'canonical_refill',true,'stay_id',NEW.stay_id,'request_id',NEW.id,'product',NEW.product_snapshot,'quantity',NEW.quantity)
 OR src.configuration_id IS DISTINCT FROM st.minibar_application_id
 OR coalesce((prsystem.minibar_stay_availability(NEW.tenant_id,NEW.stay_id,NEW.product_id)->>'available_quantity')::bigint,1000001)+NEW.quantity>1000000
 THEN RAISE EXCEPTION 'Invalid stay refill source' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER minibar_refill_request_guard BEFORE INSERT ON prsystem.minibar_refill_request FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_refill_request();

CREATE FUNCTION prsystem.guard_minibar_refill_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q prsystem.minibar_refill_request%ROWTYPE; st prsystem.stay%ROWTYPE; stock prsystem.minibar_receipt%ROWTYPE;
 product prsystem.minibar_product%ROWTYPE; task prsystem.cleaning_task%ROWTYPE;
BEGIN
 SELECT * INTO q FROM prsystem.minibar_refill_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id;
 PERFORM id FROM prsystem.room WHERE tenant_id=q.tenant_id AND id=q.room_id FOR UPDATE;
 SELECT * INTO st FROM prsystem.stay WHERE tenant_id=q.tenant_id AND id=q.stay_id FOR UPDATE;
 IF st.state IS DISTINCT FROM 'ACTIVE' OR st.room_id IS DISTINCT FROM q.room_id
 OR EXISTS(SELECT 1 FROM prsystem.reception_checkout_intent WHERE tenant_id=q.tenant_id AND stay_id=q.stay_id)
 THEN RAISE EXCEPTION 'Refill stay locked' USING ERRCODE='23514'; END IF;
 IF NEW.state<>'CANCELLED' THEN
  SELECT * INTO task FROM prsystem.cleaning_task WHERE tenant_id=NEW.tenant_id AND id=NEW.task_id FOR UPDATE;
  IF task.source_id IS DISTINCT FROM q.source_id OR task.assignee_id IS DISTINCT FROM NEW.actor_id OR task.state IS DISTINCT FROM 'OPEN'
  OR task.assignment_version IS DISTINCT FROM NEW.assignment_version
  OR NOT EXISTS(SELECT 1 FROM prsystem.staff_open_work WHERE tenant_id=NEW.tenant_id AND source_id=NEW.task_id AND kind='CLEANING_TASK' AND state='OPEN')
  THEN RAISE EXCEPTION 'Assigned open refill task required' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.state='COMPLETED' THEN
  SELECT * INTO product FROM prsystem.minibar_product WHERE tenant_id=q.tenant_id AND id=q.product_id FOR UPDATE;
  SELECT * INTO stock FROM prsystem.minibar_receipt WHERE tenant_id=q.tenant_id AND product_id=q.product_id ORDER BY stock_revision DESC LIMIT 1;
  IF NOT(product.status='ACTIVE' OR(product.status='RETIRING' AND q.recorded_at<product.deactivation_requested_at))
  OR NEW.quantity>q.quantity OR NEW.warehouse_after IS DISTINCT FROM stock.total_quantity_after-prsystem.minibar_room_quantity(q.tenant_id,q.product_id)-NEW.quantity
  OR NEW.room_after IS DISTINCT FROM prsystem.minibar_room_quantity(q.tenant_id,q.product_id,q.room_id)+NEW.quantity
  OR NEW.cost_value IS DISTINCT FROM stock.inventory_value_after OR NEW.cost_denominator IS DISTINCT FROM stock.inventory_value_denominator
  OR NEW.cost_quantity IS DISTINCT FROM stock.total_quantity_after
  THEN RAISE EXCEPTION 'Refill physical quantity or cost mismatch' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER minibar_refill_result_guard BEFORE INSERT ON prsystem.minibar_refill_result FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_refill_result();
CREATE FUNCTION prsystem.finish_minibar_refill() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source text;
BEGIN
 SELECT source_id INTO source FROM prsystem.minibar_refill_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id;
 UPDATE prsystem.cleaning_action SET completed=quantity WHERE tenant_id=NEW.tenant_id AND source_id=source;
 UPDATE prsystem.staff_open_work SET state='CLOSED' WHERE tenant_id=NEW.tenant_id AND kind='CLEANING_TASK'
  AND source_id IN(SELECT id FROM prsystem.cleaning_task WHERE tenant_id=NEW.tenant_id AND source_id=source AND state='OPEN');
 UPDATE prsystem.cleaning_task SET state='DONE' WHERE tenant_id=NEW.tenant_id AND source_id=source AND state='OPEN';
 RETURN NULL;
END; $$;
CREATE TRIGGER minibar_refill_finish AFTER INSERT ON prsystem.minibar_refill_result FOR EACH ROW EXECUTE FUNCTION prsystem.finish_minibar_refill();
CREATE FUNCTION prsystem.guard_checkout_refills() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM id FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND id=NEW.stay_id FOR UPDATE;
 IF EXISTS(SELECT 1 FROM prsystem.minibar_refill_request q WHERE q.tenant_id=NEW.tenant_id AND q.stay_id=NEW.stay_id
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_refill_result x WHERE(x.tenant_id,x.request_id)=(q.tenant_id,q.id)))
 THEN RAISE EXCEPTION 'Pending minibar refill' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER checkout_refill_guard BEFORE INSERT ON prsystem.reception_checkout_intent FOR EACH ROW EXECUTE FUNCTION prsystem.guard_checkout_refills();

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_refill_request','minibar_refill_result'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;

-- New reports retain the exact refill evidence and checkout cutoff per line.
CREATE OR REPLACE FUNCTION prsystem.guard_minibar_guest_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stay prsystem.stay%ROWTYPE; report prsystem.reception_minibar_report%ROWTYPE; item jsonb; line jsonb;
 total numeric:=0; used bigint; current_quantity bigint; availability jsonb;
BEGIN
 SELECT * INTO stay FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND id=NEW.stay_id FOR UPDATE;
 SELECT * INTO report FROM prsystem.reception_minibar_report WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id AND revision=NEW.revision;
 IF stay.state IS DISTINCT FROM 'ACTIVE' OR stay.snapshot->>'minibar_mode' IS DISTINCT FROM 'ON' OR report.actor_id IS DISTINCT FROM NEW.actor_id
 OR report.reason IS NOT NULL OR NOT EXISTS(SELECT 1 FROM prsystem.reception_minibar_inspection WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id AND state='REQUESTED' AND revision=NEW.revision-1)
 OR NOT EXISTS(SELECT 1 FROM prsystem.cleaning_task t JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
  WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.task_id AND t.source_id=NEW.source_id AND t.assignee_id=NEW.actor_id
  AND t.assignment_version=NEW.assignment_version AND t.state='OPEN' AND w.state='OPEN')
 OR EXISTS(SELECT 1 FROM prsystem.guest_charge c WHERE c.tenant_id=NEW.tenant_id AND c.stay_id=NEW.stay_id AND c.kind='MINIBAR'
  AND(c.paid_mnt>0 OR EXISTS(SELECT 1 FROM prsystem.guest_payment_intent p WHERE p.tenant_id=c.tenant_id AND p.charge_id=c.id AND p.state='PENDING')))
 THEN RAISE EXCEPTION 'Canonical report authority or payment lock' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(report.items)<>jsonb_array_length(stay.snapshot->'minibar_snapshot'->'items')
 OR (SELECT count(DISTINCT x->>'product_id') FROM jsonb_array_elements(report.items) x)<>jsonb_array_length(report.items)
 THEN RAISE EXCEPTION 'Incomplete report lines' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(stay.snapshot->'minibar_snapshot'->'items') LOOP
  SELECT x INTO line FROM jsonb_array_elements(report.items) x WHERE x->>'product_id'=item->>'product_id';
  availability:=prsystem.minibar_stay_availability(NEW.tenant_id,NEW.stay_id,item->>'product_id');
  used:=(line->>'used_quantity')::bigint;
  IF line IS NULL OR used IS NULL OR used<0 OR used>(availability->>'available_quantity')::bigint
   OR (line-ARRAY['used_quantity','actual_count','line_amount','available_quantity','refill_quantity','refill_ids','inventory_cutoff_at']) IS DISTINCT FROM item
   OR NOT(line @> availability)
   OR (line->>'actual_count')::bigint IS DISTINCT FROM (availability->>'available_quantity')::bigint-used
   OR (line->>'line_amount')::numeric IS DISTINCT FROM used::numeric*(item->>'unit_price')::bigint
  THEN RAISE EXCEPTION 'Report must use locked opening and prices' USING ERRCODE='23514'; END IF;
  total:=total+used::numeric*(item->>'unit_price')::bigint;
  SELECT prsystem.minibar_room_quantity(NEW.tenant_id,item->>'product_id',stay.room_id) INTO current_quantity;
  IF current_quantity<>(line->>'actual_count')::bigint
  OR coalesce((SELECT -sum(quantity) FROM prsystem.minibar_receipt WHERE tenant_id=NEW.tenant_id AND report_stay_id=NEW.stay_id
    AND report_revision=NEW.revision AND product_id=item->>'product_id' AND kind='CONSUMPTION'),0)<>used
  OR NOT EXISTS(SELECT 1 FROM prsystem.cleaning_action a JOIN prsystem.cleaning_posting p ON(p.tenant_id,p.source_id,p.action_id)=(a.tenant_id,a.source_id,a.id)
   WHERE a.tenant_id=NEW.tenant_id AND a.source_id=NEW.source_id AND a.kind='COUNT' AND a.product_id=item->>'product_id'
   AND p.task_id=NEW.task_id AND p.actor_id=NEW.actor_id AND p.assignment_version=NEW.assignment_version AND p.quantity=1 AND p.actual_count=current_quantity)
  THEN RAISE EXCEPTION 'Physical count and consumption proof disagree' USING ERRCODE='23514'; END IF;
 END LOOP;
 IF total<>report.amount_mnt OR NEW.no_consumption IS DISTINCT FROM (total=0)
 OR (total=0 AND report.charge_id IS NOT NULL) OR(total>0 AND NOT EXISTS(SELECT 1 FROM prsystem.guest_charge
  WHERE tenant_id=NEW.tenant_id AND id=report.charge_id AND stay_id=NEW.stay_id AND kind='MINIBAR' AND amount_mnt=total AND source_id=NEW.stay_id||':'||NEW.revision))
 OR EXISTS(SELECT 1 FROM prsystem.minibar_receipt r WHERE r.tenant_id=NEW.tenant_id AND r.report_stay_id=NEW.stay_id AND r.report_revision=NEW.revision
  AND(r.actor_id<>NEW.actor_id OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(report.items) x WHERE x->>'product_id'=r.product_id)))
 OR EXISTS(SELECT 1 FROM prsystem.minibar_receipt original WHERE original.tenant_id=NEW.tenant_id AND original.report_stay_id=NEW.stay_id
  AND original.report_revision=NEW.revision-1 AND original.kind='CONSUMPTION' AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_receipt reversal
   WHERE reversal.tenant_id=original.tenant_id AND reversal.original_receipt_id=original.id AND reversal.report_revision=NEW.revision))
 OR EXISTS(SELECT 1 FROM prsystem.minibar_receipt r JOIN prsystem.minibar_receipt original ON(original.tenant_id,original.id)=(r.tenant_id,r.original_receipt_id)
  WHERE r.tenant_id=NEW.tenant_id AND r.report_stay_id=NEW.stay_id AND r.report_revision=NEW.revision AND original.report_revision<>NEW.revision-1)
 THEN RAISE EXCEPTION 'Incomplete canonical report posting' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
