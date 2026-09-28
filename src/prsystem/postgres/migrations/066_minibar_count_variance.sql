-- Manager decisions are immutable proposals. Inventory posts only with the
-- existing complete Cleaner transfer/application transaction.
CREATE TABLE prsystem.minibar_count_resolution (
 tenant_id text NOT NULL,id text NOT NULL,request_id text NOT NULL,source_id text NOT NULL,
 product_id text NOT NULL,room_id text NOT NULL,posting_id text NOT NULL,
 request_revision bigint NOT NULL,stock_revision bigint NOT NULL,
 baseline_quantity bigint NOT NULL CHECK(baseline_quantity>=0),
 physical_quantity bigint NOT NULL CHECK(physical_quantity>=0),
 actual_count bigint NOT NULL CHECK(actual_count BETWEEN 0 AND 1000000),
 kind text NOT NULL CHECK(kind IN('COUNT','WASTE')),unit_cost_mnt bigint CHECK(unit_cost_mnt>=0),
 actor_id text NOT NULL,actor_label text NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id,product_id,request_revision),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_reconciliation,
 FOREIGN KEY(tenant_id,source_id) REFERENCES prsystem.minibar_reconciliation(tenant_id,source_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES prsystem.minibar_product,
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room,
 FOREIGN KEY(posting_id) REFERENCES prsystem.cleaning_posting,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TABLE prsystem.minibar_count_resolution_posting (
 tenant_id text NOT NULL,resolution_id text NOT NULL,request_id text NOT NULL,product_id text NOT NULL,
 adjustment_id text,task_id text NOT NULL,actor_id text NOT NULL,assignment_version bigint NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,resolution_id),UNIQUE(tenant_id,request_id,product_id),
 FOREIGN KEY(tenant_id,resolution_id) REFERENCES prsystem.minibar_count_resolution,
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_configuration_application DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,adjustment_id) REFERENCES prsystem.minibar_adjustment DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,task_id) REFERENCES prsystem.cleaning_task(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_count_resolution','minibar_count_resolution_posting'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
CREATE FUNCTION prsystem.minibar_variance_authorized(t text,actor text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
 JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id WHERE m.tenant_id=t AND m.account_id=actor
 AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.verified_at IS NOT NULL AND NOT h.security_suspended
 AND h.expires_at>clock_timestamp() AND h.package_mnt IN(25000,30000)
 AND('MANAGER'=ANY(m.roles) OR(h.package_mnt=30000 AND 'MANAGER_PLUS'=ANY(m.roles))))
$$;
CREATE FUNCTION prsystem.guard_minibar_count_resolution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q prsystem.minibar_configuration_request%ROWTYPE; e prsystem.minibar_reconciliation%ROWTYPE;
 p prsystem.cleaning_posting%ROWTYPE; b bigint; rev bigint; total bigint;
BEGIN
 SELECT * INTO q FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 SELECT * INTO e FROM prsystem.minibar_reconciliation WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id;
 SELECT * INTO p FROM prsystem.cleaning_posting WHERE id=NEW.posting_id;
 SELECT (x->>'quantity')::bigint INTO b FROM jsonb_array_elements(e.baseline) x WHERE x->>'product_id'=NEW.product_id;
 SELECT stock_revision,total_quantity_after INTO rev,total FROM prsystem.minibar_receipt WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY stock_revision DESC LIMIT 1;
 IF q.id IS NULL OR e.source_id IS DISTINCT FROM NEW.source_id OR q.room_id IS DISTINCT FROM NEW.room_id
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
CREATE TRIGGER count_resolution_guard BEFORE INSERT ON prsystem.minibar_count_resolution FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_count_resolution();
CREATE FUNCTION prsystem.minibar_count_resolution_ready(t text,r text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM prsystem.minibar_count_resolution v JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(v.tenant_id,v.request_id)
 WHERE v.tenant_id=t AND v.id=r AND q.state NOT IN('APPLIED','CANCELLED')
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_count_resolution newer WHERE newer.tenant_id=t AND newer.request_id=v.request_id AND newer.product_id=v.product_id AND newer.request_revision>v.request_revision)
 AND prsystem.minibar_variance_authorized(t,v.actor_id)
 AND v.physical_quantity=prsystem.minibar_room_quantity(t,v.product_id,v.room_id)
 AND v.stock_revision=(SELECT stock_revision FROM prsystem.minibar_receipt WHERE tenant_id=t AND product_id=v.product_id ORDER BY stock_revision DESC LIMIT 1))
$$;
CREATE FUNCTION prsystem.guard_minibar_count_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v prsystem.minibar_count_resolution%ROWTYPE;
BEGIN
 SELECT * INTO v FROM prsystem.minibar_count_resolution WHERE tenant_id=NEW.tenant_id AND id=NEW.resolution_id;
 PERFORM 1 FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id
 WHERE m.tenant_id=NEW.tenant_id AND m.account_id=v.actor_id FOR SHARE OF m,a,h;
 IF v.id IS NULL OR NOT prsystem.minibar_count_resolution_ready(NEW.tenant_id,v.id)
 OR(v.request_id,v.product_id) IS DISTINCT FROM(NEW.request_id,NEW.product_id)
 OR((v.actual_count<>v.physical_quantity) IS DISTINCT FROM (NEW.adjustment_id IS NOT NULL))
 OR NOT EXISTS(SELECT 1 FROM prsystem.cleaning_task t JOIN prsystem.staff_open_work w ON(w.tenant_id,w.source_id)=(t.tenant_id,t.id) AND w.kind='CLEANING_TASK'
 WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.task_id AND t.source_id=v.source_id AND t.assignee_id=NEW.actor_id
 AND t.assignment_version=NEW.assignment_version AND t.state='OPEN' AND w.state='OPEN')
 THEN RAISE EXCEPTION 'Count resolution is stale or outside assigned work' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER count_posting_guard BEFORE INSERT ON prsystem.minibar_count_resolution_posting FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_count_posting();
CREATE FUNCTION prsystem.prove_minibar_count_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v prsystem.minibar_count_resolution%ROWTYPE; delta bigint;
BEGIN
 SELECT * INTO STRICT v FROM prsystem.minibar_count_resolution WHERE tenant_id=NEW.tenant_id AND id=NEW.resolution_id;
 delta:=v.actual_count-v.physical_quantity;
 IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_application a WHERE a.tenant_id=NEW.tenant_id AND a.request_id=v.request_id
 AND a.room_id=v.room_id AND a.source_id=v.source_id AND a.task_id=NEW.task_id AND a.actor_id=NEW.actor_id AND a.assignment_version=NEW.assignment_version)
 OR(delta<>0 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_adjustment a JOIN prsystem.minibar_receipt r ON(r.tenant_id,r.id)=(a.tenant_id,a.receipt_id)
 WHERE a.tenant_id=NEW.tenant_id AND a.id=NEW.adjustment_id AND a.product_id=v.product_id AND a.room_id=v.room_id AND a.stay_id IS NULL
 AND a.quantity=abs(delta) AND a.hotel_delta=delta AND a.room_delta=delta AND a.billable_delta=0
 AND a.kind=(CASE WHEN v.kind='WASTE' THEN 'WASTE' WHEN delta>0 THEN 'COUNT_PLUS' ELSE 'COUNT_MINUS' END)
 AND a.actor_id=v.actor_id AND a.reason=v.reason AND r.stock_revision=v.stock_revision+1
 AND(v.unit_cost_mnt IS NULL OR(r.cost_numerator=v.unit_cost_mnt AND r.cost_denominator=1))))
 THEN RAISE EXCEPTION 'Count resolution requires atomic adjustment and application proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER count_posting_proof AFTER INSERT ON prsystem.minibar_count_resolution_posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_count_posting();
CREATE OR REPLACE FUNCTION prsystem.minibar_counts_match(t text,q text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation WHERE tenant_id=t AND request_id=q)
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation e,jsonb_array_elements(e.baseline) b
 WHERE e.tenant_id=t AND e.request_id=q AND NOT EXISTS(
 SELECT 1 FROM prsystem.cleaning_posting p JOIN prsystem.cleaning_action a ON(a.tenant_id,a.source_id,a.id)=(p.tenant_id,p.source_id,p.action_id)
 WHERE p.tenant_id=t AND p.source_id=e.source_id AND a.kind='COUNT' AND a.product_id=b->>'product_id'
 AND(p.actual_count=(b->>'quantity')::bigint OR EXISTS(
 SELECT 1 FROM prsystem.minibar_count_resolution_posting x JOIN prsystem.minibar_count_resolution v ON(v.tenant_id,v.id)=(x.tenant_id,x.resolution_id)
 WHERE x.tenant_id=t AND x.request_id=q AND x.product_id=a.product_id AND v.posting_id=p.id AND v.actual_count=p.actual_count))
 AND prsystem.minibar_room_quantity(t,a.product_id,(SELECT room_id FROM prsystem.minibar_configuration_request WHERE tenant_id=t AND id=q))
 =p.actual_count+coalesce((SELECT sum(CASE WHEN direction='REFILL' THEN quantity ELSE -quantity END) FROM prsystem.minibar_transfer WHERE tenant_id=t AND request_id=q AND product_id=a.product_id),0)))
$$;
