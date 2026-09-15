-- Manager's documented physical inspection shares the canonical report proof.
CREATE TABLE prsystem.minibar_manager_exception (
 tenant_id text NOT NULL,stay_id text NOT NULL,revision bigint NOT NULL,source_id text NOT NULL,task_id text NOT NULL,
 actor_id text NOT NULL,actor_roles text[] NOT NULL,package_mnt integer NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,stay_id,revision),UNIQUE(tenant_id,task_id),
 FOREIGN KEY(tenant_id,stay_id,revision,source_id) REFERENCES prsystem.minibar_guest_inspection(tenant_id,stay_id,revision,source_id),
 FOREIGN KEY(tenant_id,task_id,source_id) REFERENCES prsystem.cleaning_task(tenant_id,id,source_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY(tenant_id,stay_id,revision) REFERENCES prsystem.minibar_guest_report DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION prsystem.guard_minibar_manager_exception() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE roles text[]; package integer;
BEGIN
 SELECT m.roles,h.package_mnt INTO roles,package FROM prsystem.staff_membership m
 JOIN prsystem.staff_account a ON a.id=m.account_id JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id
 WHERE m.tenant_id=NEW.tenant_id AND m.account_id=NEW.actor_id AND m.status='ACTIVE' AND a.status='ACTIVE'
 AND a.verified_at IS NOT NULL AND NOT h.security_suspended;
 IF roles IS NULL OR package NOT IN(25000,30000)
 OR NOT('MANAGER'=ANY(roles) OR(package=30000 AND 'MANAGER_PLUS'=ANY(roles)))
 OR NOT EXISTS(SELECT 1 FROM prsystem.cleaning_task WHERE tenant_id=NEW.tenant_id AND id=NEW.task_id
  AND source_id=NEW.source_id AND assignee_id=NEW.actor_id AND state='OPEN')
 OR NOT EXISTS(SELECT 1 FROM prsystem.reception_minibar_inspection WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id AND state='REQUESTED' AND revision=NEW.revision-1)
 THEN RAISE EXCEPTION 'Current operational Manager and inspection required' USING ERRCODE='23514'; END IF;
 NEW.actor_roles:=roles;NEW.package_mnt:=package;NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER minibar_manager_exception_guard BEFORE INSERT ON prsystem.minibar_manager_exception FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_manager_exception();
ALTER TABLE prsystem.minibar_manager_exception ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.minibar_manager_exception FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.minibar_manager_exception USING(tenant_id=current_setting('prsystem.tenant_id',true)) WITH CHECK(tenant_id=current_setting('prsystem.tenant_id',true));
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.minibar_manager_exception FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.minibar_manager_exception FROM PUBLIC;

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
