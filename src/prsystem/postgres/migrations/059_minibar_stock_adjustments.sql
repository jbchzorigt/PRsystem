-- Manager inventory adjustments share the immutable stock revision chain.
CREATE TABLE prsystem.minibar_adjustment (
 tenant_id text NOT NULL,id text NOT NULL,product_id text NOT NULL,room_id text,stay_id text,
 kind text NOT NULL CHECK(kind IN('WASTE','COUNT_PLUS','COUNT_MINUS','RETURN','REVERSAL')),
 quantity bigint NOT NULL CHECK(quantity BETWEEN 1 AND 1000000),
 hotel_delta bigint NOT NULL,room_delta bigint NOT NULL,billable_delta bigint NOT NULL,
 original_id text,receipt_id text NOT NULL,actor_id text NOT NULL,actor_roles text[] NOT NULL,package_mnt integer NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,receipt_id),UNIQUE(tenant_id,original_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES prsystem.minibar_product,
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room,
 FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay,
 FOREIGN KEY(tenant_id,original_id) REFERENCES prsystem.minibar_adjustment,
 FOREIGN KEY(tenant_id,receipt_id) REFERENCES prsystem.minibar_receipt DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 CHECK((kind='REVERSAL')=(original_id IS NOT NULL)),CHECK(stay_id IS NULL OR room_id IS NOT NULL)
);
ALTER TABLE prsystem.minibar_adjustment ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.minibar_adjustment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.minibar_adjustment USING(tenant_id=current_setting('prsystem.tenant_id',true)) WITH CHECK(tenant_id=current_setting('prsystem.tenant_id',true));
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.minibar_adjustment FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.minibar_adjustment FROM PUBLIC;
ALTER TABLE prsystem.minibar_receipt ADD COLUMN adjustment_id text;
ALTER TABLE prsystem.minibar_receipt ADD FOREIGN KEY(tenant_id,adjustment_id) REFERENCES prsystem.minibar_adjustment;
-- Replace only the previous allowed-kind and signed-quantity constraints.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='prsystem.minibar_receipt'::regclass AND contype='c'
 AND (pg_get_constraintdef(oid) LIKE '%CONSUMPTION_REVERSAL%' AND (pg_get_constraintdef(oid) LIKE '%PURCHASE%' AND pg_get_constraintdef(oid) NOT LIKE '%room_id%')) LOOP
  EXECUTE format('ALTER TABLE prsystem.minibar_receipt DROP CONSTRAINT %I',c.conname);
 END LOOP;
END; $$;
ALTER TABLE prsystem.minibar_receipt ADD CHECK(kind IN('OPENING','PURCHASE','CONSUMPTION','CONSUMPTION_REVERSAL','ADJUSTMENT'));
ALTER TABLE prsystem.minibar_receipt ADD CHECK(kind='ADJUSTMENT' OR(kind='OPENING' AND quantity>=0) OR(kind IN('PURCHASE','CONSUMPTION_REVERSAL') AND quantity>0) OR(kind='CONSUMPTION' AND quantity<0));
ALTER TABLE prsystem.minibar_receipt ADD CHECK((kind='ADJUSTMENT')=(adjustment_id IS NOT NULL));
CREATE OR REPLACE FUNCTION prsystem.minibar_room_quantity(t text,p text,r text DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT (coalesce((SELECT sum(CASE WHEN direction='REFILL' THEN quantity ELSE -quantity END)
 FROM prsystem.minibar_transfer WHERE tenant_id=t AND product_id=p AND(r IS NULL OR room_id=r)),0)
 +coalesce((SELECT sum(quantity) FROM prsystem.minibar_receipt WHERE tenant_id=t AND product_id=p
 AND kind IN('CONSUMPTION','CONSUMPTION_REVERSAL') AND(r IS NULL OR room_id=r)),0)
 +coalesce((SELECT sum(x.quantity) FROM prsystem.minibar_refill_result x JOIN prsystem.minibar_refill_request q
 ON(q.tenant_id,q.id)=(x.tenant_id,x.request_id) WHERE q.tenant_id=t AND q.product_id=p
 AND x.state='COMPLETED' AND(r IS NULL OR q.room_id=r)),0)
 +coalesce((SELECT sum(room_delta) FROM prsystem.minibar_adjustment WHERE tenant_id=t AND product_id=p AND(r IS NULL OR room_id=r)),0))::bigint
$$;
CREATE OR REPLACE FUNCTION prsystem.minibar_stay_availability(t text,s text,p text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH base AS (
 SELECT item,intent.recorded_at FROM prsystem.stay st
 CROSS JOIN LATERAL jsonb_array_elements(st.snapshot->'minibar_snapshot'->'items') item
 LEFT JOIN prsystem.reception_checkout_intent intent ON(intent.tenant_id,intent.stay_id)=(st.tenant_id,st.id)
 WHERE st.tenant_id=t AND st.id=s AND item->>'product_id'=p
 ), refill AS (
 SELECT coalesce(sum(x.quantity),0) qty,coalesce(jsonb_agg(q.id ORDER BY q.id),'[]') ids
 FROM prsystem.minibar_refill_request q JOIN prsystem.minibar_refill_result x ON(x.tenant_id,x.request_id)=(q.tenant_id,q.id)
 WHERE q.tenant_id=t AND q.stay_id=s AND q.product_id=p AND x.state='COMPLETED'
 ), changes AS (
 SELECT coalesce(sum(billable_delta),0) billable,coalesce(sum(room_delta),0) physical,
 coalesce(jsonb_agg(id ORDER BY id),'[]') ids,max(recorded_at) last_at
 FROM prsystem.minibar_adjustment WHERE tenant_id=t AND stay_id=s AND product_id=p
 )
 SELECT jsonb_build_object('available_quantity',greatest(0,(item->>'opening_quantity')::bigint+refill.qty+changes.billable),
 'physical_quantity',(item->>'opening_quantity')::bigint+refill.qty+changes.physical,
 'refill_quantity',refill.qty,'refill_ids',refill.ids,'adjustment_ids',changes.ids,
 'non_guest_delta',changes.billable,'inventory_cutoff_at',greatest(base.recorded_at,changes.last_at))
 FROM base CROSS JOIN refill CROSS JOIN changes
$$;
CREATE FUNCTION prsystem.guard_minibar_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; old prsystem.minibar_adjustment%ROWTYPE; roles text[]; pkg integer; sign integer;
BEGIN
 IF NEW.room_id IS NOT NULL THEN
  PERFORM id FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
  SELECT id INTO st FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND room_id=NEW.room_id AND state='ACTIVE' FOR UPDATE;
  IF st IS DISTINCT FROM NEW.stay_id THEN RAISE EXCEPTION 'Current stay required' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM prsystem.reception_minibar_report WHERE tenant_id=NEW.tenant_id AND stay_id=st)
  THEN RAISE EXCEPTION 'Posted report locks stock adjustment' USING ERRCODE='23514'; END IF;
 END IF;
 PERFORM id FROM prsystem.minibar_product WHERE tenant_id=NEW.tenant_id AND id=NEW.product_id FOR UPDATE;
 SELECT m.roles,h.package_mnt INTO roles,pkg FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
 JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id WHERE m.tenant_id=NEW.tenant_id AND m.account_id=NEW.actor_id
 AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.verified_at IS NOT NULL AND NOT h.security_suspended AND h.expires_at>clock_timestamp();
 IF roles IS NULL OR pkg NOT IN(25000,30000) OR NOT('MANAGER'=ANY(roles) OR(pkg=30000 AND 'MANAGER_PLUS'=ANY(roles)))
 THEN RAISE EXCEPTION 'Current Manager required' USING ERRCODE='23514'; END IF;
 IF NEW.kind='REVERSAL' THEN
  SELECT * INTO old FROM prsystem.minibar_adjustment WHERE tenant_id=NEW.tenant_id AND id=NEW.original_id;
  IF old.kind='REVERSAL' OR old.id IS NULL OR (old.product_id,old.room_id,old.stay_id,old.quantity) IS DISTINCT FROM (NEW.product_id,NEW.room_id,NEW.stay_id,NEW.quantity)
  OR (NEW.hotel_delta,NEW.room_delta,NEW.billable_delta) IS DISTINCT FROM (-old.hotel_delta,-old.room_delta,-old.billable_delta)
  THEN RAISE EXCEPTION 'Invalid adjustment reversal' USING ERRCODE='23514'; END IF;
 ELSE
  sign:=CASE WHEN NEW.kind='COUNT_PLUS' THEN 1 ELSE -1 END;
  IF NEW.hotel_delta IS DISTINCT FROM (CASE WHEN NEW.kind='RETURN' THEN 0 ELSE sign*NEW.quantity END)
  OR NEW.room_delta IS DISTINCT FROM (CASE WHEN NEW.room_id IS NULL THEN 0 ELSE sign*NEW.quantity END)
  OR NEW.billable_delta IS DISTINCT FROM (CASE WHEN NEW.stay_id IS NULL OR NEW.kind='COUNT_PLUS' THEN 0 ELSE -NEW.quantity END)
  OR (NEW.kind='RETURN' AND NEW.room_id IS NULL)
  THEN RAISE EXCEPTION 'Invalid adjustment direction' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.room_id IS NOT NULL AND prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id,NEW.room_id)+NEW.room_delta NOT BETWEEN 0 AND 1000000
 THEN RAISE EXCEPTION 'Invalid physical stock' USING ERRCODE='23514'; END IF;
 NEW.actor_roles:=roles;NEW.package_mnt:=pkg;NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER minibar_adjustment_guard BEFORE INSERT ON prsystem.minibar_adjustment FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_adjustment();
CREATE OR REPLACE FUNCTION prsystem.guard_minibar_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE product prsystem.minibar_product%ROWTYPE; prior prsystem.minibar_receipt%ROWTYPE; original prsystem.minibar_receipt%ROWTYPE;
 adj prsystem.minibar_adjustment%ROWTYPE; n numeric; d numeric; room_before bigint; total_before bigint; delta_room bigint:=0;
BEGIN
 SELECT * INTO product FROM prsystem.minibar_product WHERE tenant_id=NEW.tenant_id AND id=NEW.product_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing inventory product' USING ERRCODE='23514'; END IF;
 SELECT * INTO prior FROM prsystem.minibar_receipt WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY stock_revision DESC LIMIT 1;
 total_before:=coalesce(prior.total_quantity_after,0);n:=coalesce(prior.inventory_value_after,0);d:=coalesce(prior.inventory_value_denominator,1);
 IF NEW.kind IN ('OPENING','PURCHASE') THEN
  NEW.cost_numerator:=NEW.unit_cost_mnt;NEW.cost_denominator:=1;
  IF (NEW.kind='OPENING' AND NEW.unit_cost_mnt<>product.initial_unit_cost_mnt) OR (NEW.kind='PURCHASE' AND product.status<>'ACTIVE')
  THEN RAISE EXCEPTION 'Invalid receipt product' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind='ADJUSTMENT' THEN
  SELECT * INTO adj FROM prsystem.minibar_adjustment WHERE tenant_id=NEW.tenant_id AND id=NEW.adjustment_id;
  IF adj.id IS NULL OR (adj.receipt_id,adj.product_id,adj.room_id,adj.hotel_delta,adj.actor_id) IS DISTINCT FROM (NEW.id,NEW.product_id,NEW.room_id,NEW.quantity,NEW.actor_id)
  OR NEW.unit_cost_mnt<>0 OR NEW.report_stay_id IS NOT NULL OR NEW.report_revision IS NOT NULL
  THEN RAISE EXCEPTION 'Invalid adjustment receipt' USING ERRCODE='23514'; END IF;
  IF adj.kind='REVERSAL' THEN
   SELECT r.* INTO original FROM prsystem.minibar_receipt r JOIN prsystem.minibar_adjustment a ON(a.tenant_id,a.receipt_id)=(r.tenant_id,r.id)
    WHERE a.tenant_id=NEW.tenant_id AND a.id=adj.original_id;
   IF original.id IS NULL OR NEW.cost_numerator*original.cost_denominator<>original.cost_numerator*NEW.cost_denominator
   THEN RAISE EXCEPTION 'Reversal must retain original cost' USING ERRCODE='23514'; END IF;
  ELSIF total_before>0 THEN
   IF NEW.cost_numerator*d*total_before<>n*NEW.cost_denominator THEN RAISE EXCEPTION 'Incorrect adjustment average cost' USING ERRCODE='23514'; END IF;
  ELSIF adj.kind<>'COUNT_PLUS' OR NEW.cost_denominator<>1 THEN
   RAISE EXCEPTION 'Opening adjustment cost required' USING ERRCODE='23514';
  END IF;
 ELSE
  PERFORM 1 FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND id=NEW.report_stay_id AND room_id=NEW.room_id AND state='ACTIVE' AND snapshot->>'minibar_mode'='ON';
  IF NOT FOUND OR NEW.unit_cost_mnt<>0 THEN RAISE EXCEPTION 'Invalid consumption stay' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM prsystem.reception_minibar_inspection WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.report_stay_id
    AND state='REQUESTED' AND revision=NEW.report_revision-1;
  IF NOT FOUND THEN RAISE EXCEPTION 'Consumption report is not open' USING ERRCODE='23514'; END IF;
  delta_room:=NEW.quantity;room_before:=prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id,NEW.room_id);
  IF room_before+NEW.quantity<0 THEN RAISE EXCEPTION 'Insufficient room stock' USING ERRCODE='23514'; END IF;
  IF NEW.kind='CONSUMPTION' THEN
   IF total_before<=0 OR NEW.cost_numerator*d*total_before<>n*NEW.cost_denominator
   THEN RAISE EXCEPTION 'Incorrect consumption cost' USING ERRCODE='23514'; END IF;
  ELSE
   SELECT * INTO original FROM prsystem.minibar_receipt WHERE tenant_id=NEW.tenant_id AND id=NEW.original_receipt_id;
   IF original.kind IS DISTINCT FROM 'CONSUMPTION' OR (original.report_stay_id,original.product_id,original.room_id) IS DISTINCT FROM (NEW.report_stay_id,NEW.product_id,NEW.room_id)
   OR original.report_revision>=NEW.report_revision OR NEW.quantity<>-original.quantity
   OR NEW.cost_numerator*original.cost_denominator<>original.cost_numerator*NEW.cost_denominator
   THEN RAISE EXCEPTION 'Invalid consumption reversal' USING ERRCODE='23514'; END IF;
  END IF;
 END IF;
 NEW.total_quantity_after:=total_before+NEW.quantity;
 IF NEW.stock_revision<>coalesce(prior.stock_revision,0)+1
 OR NEW.warehouse_after::numeric<>NEW.total_quantity_after::numeric-prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id)-delta_room
 OR NEW.inventory_value_after*d*NEW.cost_denominator<>(n*NEW.cost_denominator+NEW.quantity::numeric*NEW.cost_numerator*d)*NEW.inventory_value_denominator
 OR NEW.product_snapshot<>jsonb_build_object('name',product.name,'category',product.category,'unit',product.unit,'selling_price_mnt',product.selling_price_mnt,'revision',product.revision)
 THEN RAISE EXCEPTION 'Invalid inventory receipt' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.guard_minibar_guest_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stay prsystem.stay%ROWTYPE; report prsystem.reception_minibar_report%ROWTYPE; item jsonb; line jsonb;
 total numeric:=0; used bigint; current_quantity bigint; availability jsonb;
BEGIN
 SELECT * INTO stay FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND id=NEW.stay_id FOR UPDATE;
 SELECT * INTO report FROM prsystem.reception_minibar_report WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id AND revision=NEW.revision;
 IF stay.state IS DISTINCT FROM 'ACTIVE' OR stay.snapshot->>'minibar_mode' IS DISTINCT FROM 'ON' OR report.actor_id IS DISTINCT FROM NEW.actor_id
 OR (report.reason IS NOT NULL AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_manager_exception x WHERE x.tenant_id=NEW.tenant_id AND x.stay_id=NEW.stay_id AND x.revision=NEW.revision AND x.task_id=NEW.task_id AND x.actor_id=NEW.actor_id AND x.reason=report.reason))
 OR (report.reason IS NULL AND EXISTS(SELECT 1 FROM prsystem.minibar_manager_exception x WHERE x.tenant_id=NEW.tenant_id AND x.stay_id=NEW.stay_id AND x.revision=NEW.revision))
 OR NOT EXISTS(SELECT 1 FROM prsystem.reception_minibar_inspection WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id AND state='REQUESTED' AND revision=NEW.revision-1)
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
   OR (line-ARRAY['used_quantity','actual_count','line_amount','available_quantity','refill_quantity','refill_ids','inventory_cutoff_at','physical_quantity','adjustment_ids','non_guest_delta']) IS DISTINCT FROM item
   OR NOT(line @> availability)
   OR used IS DISTINCT FROM greatest(0,(availability->>'available_quantity')::bigint-(line->>'actual_count')::bigint)
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

CREATE FUNCTION prsystem.prove_minibar_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_receipt WHERE tenant_id=NEW.tenant_id AND id=NEW.receipt_id AND kind='ADJUSTMENT' AND adjustment_id=NEW.id)
 THEN RAISE EXCEPTION 'Adjustment requires matching stock receipt' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER prove_minibar_adjustment AFTER INSERT ON prsystem.minibar_adjustment DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_adjustment();
