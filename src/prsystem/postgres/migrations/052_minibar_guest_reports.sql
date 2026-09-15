-- The immutable stay owns its check-in price book. No historical price lookup.
ALTER TABLE prsystem.stay ADD COLUMN minibar_application_id text;
ALTER TABLE prsystem.stay ADD FOREIGN KEY(tenant_id,minibar_application_id)
 REFERENCES prsystem.minibar_configuration_application(tenant_id,request_id);

CREATE FUNCTION prsystem.minibar_guest_opening(t text,r text,recorded timestamptz) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE req prsystem.minibar_configuration_request%ROWTYPE; result jsonb; lines jsonb;
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
 -- Until the explicit shortage-override adapter exists, only a fully stocked room is eligible.
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(req.target_snapshot->'items') x LEFT JOIN prsystem.minibar_product p
 ON p.tenant_id=t AND p.id=x->>'product_id' WHERE p.status IS DISTINCT FROM 'ACTIVE'
 OR prsystem.minibar_room_quantity(t,p.id,r) IS DISTINCT FROM (x->>'target_quantity')::bigint)
 OR EXISTS(SELECT 1 FROM prsystem.minibar_product p WHERE p.tenant_id=t AND prsystem.minibar_room_quantity(t,p.id,r)<>0
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(req.target_snapshot->'items') x WHERE x->>'product_id'=p.id))
 THEN RETURN NULL; END IF;
 SELECT jsonb_agg(jsonb_build_object('product_id',p.id,'name',p.name,'category',p.category,'unit',p.unit,
  'unit_price',p.selling_price_mnt,'product_revision',p.revision,'target_quantity',(x->>'target_quantity')::bigint,
  'opening_quantity',prsystem.minibar_room_quantity(t,p.id,r)) ORDER BY p.id) INTO lines
 FROM jsonb_array_elements(req.target_snapshot->'items') x JOIN prsystem.minibar_product p ON p.tenant_id=t AND p.id=x->>'product_id';
 IF lines IS NULL THEN RETURN NULL; END IF;
 RETURN (req.target_snapshot-'items')||jsonb_build_object('mode','CANONICAL','application_id',req.id,'recorded_at',recorded,'items',lines);
END; $$;

CREATE FUNCTION prsystem.guard_minibar_stay_opening() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode text; opening jsonb;
BEGIN
 SELECT minibar_mode INTO mode FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
 IF mode='ON' OR NEW.snapshot->>'minibar_mode'='ON' THEN
  opening:=prsystem.minibar_guest_opening(NEW.tenant_id,NEW.room_id,NEW.check_in_recorded_at);
  IF mode IS DISTINCT FROM 'ON' OR NEW.snapshot->>'minibar_mode' IS DISTINCT FROM 'ON'
   OR opening IS NULL OR NEW.snapshot->'minibar_snapshot' IS DISTINCT FROM opening
  THEN RAISE EXCEPTION 'Canonical minibar opening required' USING ERRCODE='23514'; END IF;
  NEW.minibar_application_id:=opening->>'application_id';
 ELSIF NEW.minibar_application_id IS NOT NULL THEN
  RAISE EXCEPTION 'Unexpected minibar application' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER canonical_stay_opening BEFORE INSERT ON prsystem.stay FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_stay_opening();

CREATE TABLE prsystem.minibar_guest_inspection (
 tenant_id text NOT NULL,stay_id text NOT NULL,revision bigint NOT NULL CHECK(revision>0),source_id text NOT NULL,
 PRIMARY KEY(tenant_id,stay_id,revision),UNIQUE(tenant_id,source_id),UNIQUE(tenant_id,stay_id,revision,source_id),
 FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.reception_checkout_intent,
 FOREIGN KEY(tenant_id,source_id) REFERENCES prsystem.cleaning_source
);
CREATE TABLE prsystem.minibar_guest_report (
 tenant_id text NOT NULL,stay_id text NOT NULL,revision bigint NOT NULL,source_id text NOT NULL,task_id text NOT NULL,
 assignment_version bigint NOT NULL,actor_id text NOT NULL,no_consumption boolean NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,stay_id,revision),UNIQUE(tenant_id,task_id),
 FOREIGN KEY(tenant_id,stay_id,revision,source_id) REFERENCES prsystem.minibar_guest_inspection(tenant_id,stay_id,revision,source_id),
 FOREIGN KEY(tenant_id,task_id,source_id) REFERENCES prsystem.cleaning_task(tenant_id,id,source_id),
 FOREIGN KEY(tenant_id,stay_id,revision) REFERENCES prsystem.reception_minibar_report,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
ALTER TABLE prsystem.minibar_receipt ADD FOREIGN KEY(tenant_id,report_stay_id,report_revision)
 REFERENCES prsystem.minibar_guest_report DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION prsystem.guard_minibar_guest_inspection() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stay prsystem.stay%ROWTYPE; source prsystem.cleaning_source%ROWTYPE;
BEGIN
 SELECT * INTO stay FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND id=NEW.stay_id;
 SELECT * INTO source FROM prsystem.cleaning_source WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id;
 IF stay.state IS DISTINCT FROM 'ACTIVE' OR stay.snapshot->>'minibar_mode' IS DISTINCT FROM 'ON'
 OR source.room_id IS DISTINCT FROM stay.room_id OR source.source_kind IS DISTINCT FROM 'CHECKOUT'
 OR source.source_reference IS DISTINCT FROM 'minibar-report:'||NEW.stay_id||':'||NEW.revision
 OR source.snapshot IS DISTINCT FROM jsonb_build_object('canonical_minibar',true,'canonical_guest',true,'stay_id',NEW.stay_id,'price_book',stay.snapshot->'minibar_snapshot')
 OR NOT EXISTS(SELECT 1 FROM prsystem.reception_minibar_inspection WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id
  AND state='REQUESTED' AND revision=NEW.revision-1)
 THEN RAISE EXCEPTION 'Invalid canonical inspection source' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER minibar_guest_inspection_guard BEFORE INSERT ON prsystem.minibar_guest_inspection FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_guest_inspection();

CREATE FUNCTION prsystem.guard_minibar_guest_report() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE stay prsystem.stay%ROWTYPE; report prsystem.reception_minibar_report%ROWTYPE; item jsonb; line jsonb;
 total numeric:=0; used bigint; current_quantity bigint;
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
  used:=(line->>'used_quantity')::bigint;
  IF line IS NULL OR used IS NULL OR used<0 OR used>(item->>'opening_quantity')::bigint
   OR (line-ARRAY['used_quantity','actual_count','line_amount']) IS DISTINCT FROM item
   OR (line->>'actual_count')::bigint IS DISTINCT FROM (item->>'opening_quantity')::bigint-used
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
CREATE TRIGGER minibar_guest_report_guard BEFORE INSERT ON prsystem.minibar_guest_report FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_guest_report();

CREATE FUNCTION prsystem.finish_minibar_guest_report() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE prsystem.cleaning_action SET completed=quantity WHERE tenant_id=NEW.tenant_id AND source_id=NEW.source_id;
 UPDATE prsystem.cleaning_task SET state='DONE',started_at=coalesce(started_at,NEW.recorded_at) WHERE tenant_id=NEW.tenant_id AND id=NEW.task_id;
 UPDATE prsystem.staff_open_work SET state='CLOSED' WHERE tenant_id=NEW.tenant_id AND source_id=NEW.task_id AND kind='CLEANING_TASK';
 UPDATE prsystem.reception_minibar_inspection SET state='REPORTED',revision=NEW.revision WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id;
 RETURN NULL;
END; $$;
CREATE TRIGGER minibar_guest_report_finish AFTER INSERT ON prsystem.minibar_guest_report FOR EACH ROW EXECUTE FUNCTION prsystem.finish_minibar_guest_report();

CREATE FUNCTION prsystem.require_canonical_report_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND id=NEW.stay_id AND snapshot->>'minibar_mode'='ON')
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_guest_report WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id AND revision=NEW.revision)
 THEN RAISE EXCEPTION 'Canonical report proof required' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER canonical_report_proof AFTER INSERT ON prsystem.reception_minibar_report DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION prsystem.require_canonical_report_proof();
CREATE CONSTRAINT TRIGGER canonical_inspection_proof AFTER INSERT OR UPDATE ON prsystem.reception_minibar_inspection DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(NEW.state IN('REPORTED','DISPUTED')) EXECUTE FUNCTION prsystem.require_canonical_report_proof();

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_guest_inspection','minibar_guest_report'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
