-- Canonical counts and full-plan atomic configuration completion.
-- No pending request can commit a partial transfer in this adapter.
ALTER TABLE prsystem.minibar_receipt DISABLE TRIGGER minibar_receipt_immutable;
ALTER TABLE prsystem.minibar_receipt ADD COLUMN total_quantity_after bigint;
UPDATE prsystem.minibar_receipt SET total_quantity_after=warehouse_after;
ALTER TABLE prsystem.minibar_receipt ALTER COLUMN total_quantity_after SET NOT NULL;
ALTER TABLE prsystem.minibar_receipt ENABLE TRIGGER minibar_receipt_immutable;
ALTER TABLE prsystem.minibar_receipt ADD CHECK(total_quantity_after>=0);

CREATE TABLE prsystem.minibar_reconciliation (
 tenant_id text NOT NULL,request_id text NOT NULL,source_id text NOT NULL,
 baseline jsonb NOT NULL,created_by text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id),UNIQUE(tenant_id,source_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_configuration_request,
 FOREIGN KEY(tenant_id,source_id) REFERENCES prsystem.cleaning_source,
 FOREIGN KEY(tenant_id,created_by) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TABLE prsystem.minibar_configuration_application (
 tenant_id text NOT NULL,request_id text NOT NULL,room_id text NOT NULL,source_id text NOT NULL,task_id text NOT NULL,
 actor_id text NOT NULL,assignment_version bigint NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,request_id),UNIQUE(tenant_id,room_id,request_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_reconciliation,
 FOREIGN KEY(tenant_id,task_id,source_id) REFERENCES prsystem.cleaning_task(tenant_id,id,source_id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room
);
CREATE TABLE prsystem.minibar_transfer (
 tenant_id text NOT NULL,id text NOT NULL,request_id text NOT NULL,source_id text NOT NULL,task_id text NOT NULL,
 product_id text NOT NULL,room_id text NOT NULL,actor_id text NOT NULL,
 direction text NOT NULL CHECK(direction IN ('REFILL','RETURN')),quantity bigint NOT NULL CHECK(quantity>0),
 warehouse_after bigint NOT NULL CHECK(warehouse_after>=0),room_after bigint NOT NULL CHECK(room_after>=0),
 cost_value numeric(39,0) NOT NULL CHECK(cost_value>=0),cost_quantity bigint NOT NULL CHECK(cost_quantity>0),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,request_id,product_id),
 FOREIGN KEY(tenant_id,request_id) REFERENCES prsystem.minibar_reconciliation,
 FOREIGN KEY(tenant_id,task_id,source_id) REFERENCES prsystem.cleaning_task(tenant_id,id,source_id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES prsystem.minibar_product,
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE INDEX minibar_transfer_product ON prsystem.minibar_transfer(tenant_id,product_id);
CREATE FUNCTION prsystem.minibar_room_quantity(t text,p text,r text DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT coalesce(sum(CASE WHEN direction='REFILL' THEN quantity ELSE -quantity END),0)::bigint
 FROM prsystem.minibar_transfer WHERE tenant_id=t AND product_id=p AND (r IS NULL OR room_id=r)
$$;
CREATE FUNCTION prsystem.minibar_safe_room(t text,r text,own_source text DEFAULT NULL) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM prsystem.stay s LEFT JOIN prsystem.stay_checkout c ON(c.tenant_id,c.stay_id)=(s.tenant_id,s.id)
   WHERE s.tenant_id=t AND s.room_id=r AND (s.state='ACTIVE' OR c.stay_id IS NULL))
 AND NOT EXISTS(SELECT 1 FROM prsystem.cleaning_source s JOIN prsystem.cleaning_action a ON(a.tenant_id,a.source_id)=(s.tenant_id,s.id)
   WHERE s.tenant_id=t AND s.room_id=r AND s.id IS DISTINCT FROM own_source AND a.kind<>'CLEAN' AND a.completed<a.quantity
   AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation e JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(e.tenant_id,e.request_id)
     WHERE e.tenant_id=t AND e.source_id=s.id AND q.state='CANCELLED'))
 AND NOT EXISTS(SELECT 1 FROM prsystem.stay s JOIN prsystem.reception_minibar_inspection i ON(i.tenant_id,i.stay_id)=(s.tenant_id,s.id)
   WHERE s.tenant_id=t AND s.room_id=r AND i.state<>'REPORTED')
 AND NOT EXISTS(SELECT 1 FROM prsystem.stay s JOIN prsystem.guest_payment_intent p ON(p.tenant_id,p.stay_id)=(s.tenant_id,s.id)
   WHERE s.tenant_id=t AND s.room_id=r AND p.state='PENDING')
 AND NOT EXISTS(SELECT 1 FROM prsystem.stay s JOIN prsystem.guest_correction p ON(p.tenant_id,p.stay_id)=(s.tenant_id,s.id)
   WHERE s.tenant_id=t AND s.room_id=r AND p.state='PENDING')
$$;
CREATE FUNCTION prsystem.minibar_configuration_baseline(t text,q text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH req AS(SELECT * FROM prsystem.minibar_configuration_request WHERE tenant_id=t AND id=q),
 products AS(SELECT x->>'product_id' id FROM req,jsonb_array_elements(target_snapshot->'items') x
 UNION SELECT m.product_id FROM prsystem.minibar_transfer m,req WHERE m.tenant_id=t AND m.room_id=req.room_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',p.id,'name',p.name,'unit',p.unit,
 'quantity',prsystem.minibar_room_quantity(t,p.id,req.room_id)) ORDER BY p.id),'[]'::jsonb)
 FROM products JOIN prsystem.minibar_product p ON p.tenant_id=t AND p.id=products.id CROSS JOIN req
$$;
CREATE FUNCTION prsystem.guard_minibar_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE req prsystem.minibar_configuration_request%ROWTYPE; src prsystem.cleaning_source%ROWTYPE;
BEGIN
 SELECT * INTO req FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 SELECT * INTO src FROM prsystem.cleaning_source WHERE tenant_id=NEW.tenant_id AND id=NEW.source_id;
 IF req.state NOT IN ('READY_FOR_RECONCILIATION','SCHEDULED_AFTER_STAY') OR src.room_id IS DISTINCT FROM req.room_id
 OR src.source_kind IS DISTINCT FROM 'CONFIGURATION' OR src.source_reference IS DISTINCT FROM 'canonical-config:'||req.id
 OR NOT prsystem.minibar_safe_room(NEW.tenant_id,req.room_id,src.id)
 OR (SELECT minibar_mode FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=req.room_id)='MOCK_ON'
 THEN RAISE EXCEPTION 'Reconciliation source not ready' USING ERRCODE='23514'; END IF;
 NEW.baseline:=prsystem.minibar_configuration_baseline(NEW.tenant_id,req.id);
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER minibar_reconciliation_guard BEFORE INSERT ON prsystem.minibar_reconciliation
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_reconciliation();

ALTER TABLE prsystem.room DROP CONSTRAINT room_minibar_mode_check;
ALTER TABLE prsystem.room ADD CHECK(minibar_mode IN ('OFF','MOCK_ON','ON'));
ALTER TABLE prsystem.room ADD COLUMN minibar_application_id text;
ALTER TABLE prsystem.room ADD FOREIGN KEY(tenant_id,id,minibar_application_id)
 REFERENCES prsystem.minibar_configuration_application(tenant_id,room_id,request_id);
ALTER TABLE prsystem.room ADD CHECK(minibar_mode<>'ON' OR minibar_application_id IS NOT NULL);
ALTER TABLE prsystem.minibar_configuration_request DROP CONSTRAINT minibar_configuration_request_state_check;
ALTER TABLE prsystem.minibar_configuration_request ADD CHECK(state IN
 ('SCHEDULED_AFTER_STAY','READY_FOR_RECONCILIATION','IN_PROGRESS','BLOCKED_VARIANCE','BLOCKED_STOCK','APPLIED','CANCELLED'));
DROP INDEX prsystem.one_pending_minibar_configuration;
CREATE UNIQUE INDEX one_pending_minibar_configuration ON prsystem.minibar_configuration_request(tenant_id,room_id)
 WHERE state NOT IN ('CANCELLED','APPLIED');

CREATE OR REPLACE FUNCTION prsystem.guard_minibar_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE product prsystem.minibar_product%ROWTYPE; prior prsystem.minibar_receipt%ROWTYPE;
BEGIN
    SELECT * INTO product FROM prsystem.minibar_product
      WHERE tenant_id=NEW.tenant_id AND id=NEW.product_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Missing inventory product' USING ERRCODE='23514'; END IF;
    SELECT * INTO prior FROM prsystem.minibar_receipt WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY stock_revision DESC LIMIT 1;
    NEW.total_quantity_after:=coalesce(prior.total_quantity_after,0)+NEW.quantity;
    IF NEW.stock_revision<>coalesce(prior.stock_revision,0)+1
       OR NEW.warehouse_after::numeric<>NEW.total_quantity_after::numeric-prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id)
       OR NEW.inventory_value_after<>coalesce(prior.inventory_value_after,0)+NEW.quantity::numeric*NEW.unit_cost_mnt
       OR (NEW.kind='OPENING' AND NEW.unit_cost_mnt<>product.initial_unit_cost_mnt)
       OR (NEW.kind='PURCHASE' AND product.status<>'ACTIVE')
       OR NEW.product_snapshot<>jsonb_build_object('name',product.name,'category',product.category,
           'unit',product.unit,'selling_price_mnt',product.selling_price_mnt,'revision',product.revision)
    THEN RAISE EXCEPTION 'Invalid inventory receipt' USING ERRCODE='23514'; END IF;
    RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.guard_minibar_configuration_request() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE room prsystem.room%ROWTYPE; template prsystem.minibar_template%ROWTYPE;
 version prsystem.minibar_template_version%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable configuration history' USING ERRCODE='23514'; END IF;
 IF TG_OP='UPDATE' THEN
   IF OLD.state IN ('CANCELLED','APPLIED') OR NEW.state NOT IN ('CANCELLED','APPLIED','IN_PROGRESS','BLOCKED_VARIANCE','BLOCKED_STOCK') OR NEW.revision<>OLD.revision+1
     OR (to_jsonb(NEW)-ARRAY['state','revision','cancelled_by','cancel_reason','cancelled_at'])
        IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','cancelled_by','cancel_reason','cancelled_at'])
   THEN RAISE EXCEPTION 'Invalid configuration transition' USING ERRCODE='23514'; END IF;
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
 NEW.state:=CASE WHEN NEW.active_stay_id IS NOT NULL THEN 'SCHEDULED_AFTER_STAY' ELSE 'READY_FOR_RECONCILIATION' END;
 NEW.revision:=1; NEW.recorded_at:=clock_timestamp();
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.sync_minibar_configuration_blocker() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO prsystem.reception_dependency_blocker(tenant_id,room_id,source_kind,source_id,state)
 VALUES(NEW.tenant_id,NEW.room_id,'MINIBAR_CONFIGURATION',NEW.id,CASE WHEN NEW.state IN ('CANCELLED','APPLIED') THEN 'DONE' ELSE 'OPEN' END)
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
     OR NEW.state IS DISTINCT FROM (CASE WHEN request_state IN ('CANCELLED','APPLIED') THEN 'DONE' ELSE 'OPEN' END)
   THEN RAISE EXCEPTION 'Configuration blocker disagrees with source' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION prsystem.minibar_counts_match(t text,q text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation e,jsonb_array_elements(e.baseline) b
 WHERE e.tenant_id=t AND e.request_id=q AND NOT EXISTS(
 SELECT 1 FROM prsystem.cleaning_posting p JOIN prsystem.cleaning_action a ON(a.tenant_id,a.source_id,a.id)=(p.tenant_id,p.source_id,p.action_id)
 WHERE p.tenant_id=t AND p.source_id=e.source_id AND a.kind='COUNT' AND a.product_id=b->>'product_id' AND p.actual_count=(b->>'quantity')::bigint))
 AND EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation WHERE tenant_id=t AND request_id=q)
$$;
CREATE FUNCTION prsystem.guard_minibar_transfer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE req prsystem.minibar_configuration_request%ROWTYPE; total bigint; value numeric; before_room bigint; before_wh bigint; target bigint;
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
 SELECT total_quantity_after,inventory_value_after INTO total,value FROM prsystem.minibar_receipt
 WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY stock_revision DESC LIMIT 1;
 before_room:=prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id,NEW.room_id);
 before_wh:=total-prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id);
 SELECT coalesce(sum((x->>'target_quantity')::bigint),0) INTO target FROM jsonb_array_elements(req.target_snapshot->'items') x WHERE x->>'product_id'=NEW.product_id;
 IF (NEW.direction='REFILL' AND (target<=before_room OR NEW.quantity<>target-before_room OR NEW.quantity>before_wh))
 OR (NEW.direction='RETURN' AND (before_room<=target OR NEW.quantity<>before_room-target))
 OR NEW.room_after<>target OR NEW.warehouse_after<>before_wh+(CASE WHEN NEW.direction='RETURN' THEN NEW.quantity ELSE -NEW.quantity END)
 OR NEW.cost_value<>value OR NEW.cost_quantity<>total
 THEN RAISE EXCEPTION 'Invalid bounded transfer' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER minibar_transfer_guard BEFORE INSERT ON prsystem.minibar_transfer FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_transfer();
CREATE FUNCTION prsystem.require_atomic_minibar_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_application WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id)
 THEN RAISE EXCEPTION 'Partial configuration transfers cannot commit' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER minibar_transfer_application AFTER INSERT ON prsystem.minibar_transfer DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION prsystem.require_atomic_minibar_application();
CREATE FUNCTION prsystem.guard_minibar_application() RETURNS trigger LANGUAGE plpgsql AS $$
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
   SELECT coalesce(sum((x->>'target_quantity')::bigint),0) INTO target FROM jsonb_array_elements(req.target_snapshot->'items') x WHERE x->>'product_id'=item->>'product_id';
   IF (item->>'quantity')::bigint<>target THEN RAISE EXCEPTION 'Room balance does not match target' USING ERRCODE='23514'; END IF;
 END LOOP;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER minibar_application_guard BEFORE INSERT ON prsystem.minibar_configuration_application FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_application();
CREATE FUNCTION prsystem.apply_minibar_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mode text;
BEGIN
 UPDATE prsystem.minibar_configuration_request SET state='APPLIED',revision=revision+1 WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id RETURNING target_mode INTO mode;
 UPDATE prsystem.room SET minibar_mode=mode,minibar_application_id=NEW.request_id,revision=revision+1 WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id;
 UPDATE prsystem.cleaning_task SET state='DONE' WHERE tenant_id=NEW.tenant_id AND id=NEW.task_id;
 UPDATE prsystem.staff_open_work SET state='CLOSED' WHERE tenant_id=NEW.tenant_id AND kind='CLEANING_TASK' AND source_id=NEW.task_id;
 INSERT INTO prsystem.reception_dependency_blocker(tenant_id,room_id,source_kind,source_id,state)
 VALUES(NEW.tenant_id,NEW.room_id,'CANONICAL_MINIBAR',NEW.room_id,CASE WHEN mode='ON' THEN 'OPEN' ELSE 'DONE' END)
 ON CONFLICT(tenant_id,source_kind,source_id) DO UPDATE SET state=EXCLUDED.state;
 RETURN NULL;
END; $$;
CREATE TRIGGER minibar_apply AFTER INSERT ON prsystem.minibar_configuration_application FOR EACH ROW EXECUTE FUNCTION prsystem.apply_minibar_configuration();
CREATE FUNCTION prsystem.guard_canonical_room() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE req prsystem.minibar_configuration_request%ROWTYPE;
BEGIN
 IF NEW.minibar_application_id IS DISTINCT FROM OLD.minibar_application_id OR NEW.minibar_mode IS DISTINCT FROM OLD.minibar_mode THEN
 IF OLD.minibar_mode='ON' OR NEW.minibar_mode='ON' OR NEW.minibar_application_id IS DISTINCT FROM OLD.minibar_application_id THEN
   SELECT * INTO req FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.minibar_application_id;
   IF req.state IS DISTINCT FROM 'APPLIED' OR req.room_id IS DISTINCT FROM NEW.id OR req.target_mode IS DISTINCT FROM NEW.minibar_mode
      OR (NEW.minibar_application_id IS DISTINCT FROM OLD.minibar_application_id AND (req.source_snapshot->>'application_id') IS DISTINCT FROM OLD.minibar_application_id)
   THEN RAISE EXCEPTION 'Canonical configuration requires application' USING ERRCODE='23514'; END IF;
 END IF; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER canonical_room_guard BEFORE UPDATE ON prsystem.room FOR EACH ROW EXECUTE FUNCTION prsystem.guard_canonical_room();
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_reconciliation','minibar_transfer','minibar_configuration_application'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
