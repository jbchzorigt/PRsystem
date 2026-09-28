-- Stay consumption shares the immutable stock revision chain with purchases.
-- Rational valuation stores an integer numerator and denominator without rounding.
ALTER TABLE prsystem.minibar_receipt ALTER COLUMN inventory_value_after TYPE numeric;
ALTER TABLE prsystem.minibar_receipt ADD COLUMN inventory_value_denominator numeric NOT NULL DEFAULT 1 CHECK(inventory_value_denominator>0 AND inventory_value_denominator=trunc(inventory_value_denominator));
ALTER TABLE prsystem.minibar_receipt ADD CHECK(inventory_value_after=trunc(inventory_value_after));
ALTER TABLE prsystem.minibar_receipt ADD COLUMN cost_numerator numeric NOT NULL DEFAULT 0 CHECK(cost_numerator>=0 AND cost_numerator=trunc(cost_numerator));
ALTER TABLE prsystem.minibar_receipt ADD COLUMN cost_denominator numeric NOT NULL DEFAULT 1 CHECK(cost_denominator>0 AND cost_denominator=trunc(cost_denominator));
ALTER TABLE prsystem.minibar_receipt ADD COLUMN room_id text;
ALTER TABLE prsystem.minibar_receipt ADD COLUMN report_stay_id text;
ALTER TABLE prsystem.minibar_receipt ADD COLUMN report_revision bigint;
ALTER TABLE prsystem.minibar_receipt ADD COLUMN original_receipt_id text;
ALTER TABLE prsystem.minibar_receipt ADD FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room;
ALTER TABLE prsystem.minibar_receipt ADD FOREIGN KEY(tenant_id,original_receipt_id) REFERENCES prsystem.minibar_receipt;
ALTER TABLE prsystem.minibar_receipt ADD FOREIGN KEY(tenant_id,report_stay_id,report_revision)
 REFERENCES prsystem.reception_minibar_report DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX minibar_consumption_reversal_once ON prsystem.minibar_receipt(tenant_id,original_receipt_id) WHERE original_receipt_id IS NOT NULL;
CREATE UNIQUE INDEX minibar_consumption_report_product ON prsystem.minibar_receipt(tenant_id,report_stay_id,report_revision,product_id,kind) WHERE report_stay_id IS NOT NULL;
ALTER TABLE prsystem.minibar_receipt DROP CONSTRAINT minibar_receipt_kind_check;
ALTER TABLE prsystem.minibar_receipt DROP CONSTRAINT minibar_receipt_quantity_check;
-- Locate the original unnamed positive-purchase constraint without touching opening/revision.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='prsystem.minibar_receipt'::regclass AND contype='c'
 AND pg_get_constraintdef(oid) LIKE '%quantity > 0%' LOOP EXECUTE format('ALTER TABLE prsystem.minibar_receipt DROP CONSTRAINT %I',c.conname); END LOOP;
END; $$;
ALTER TABLE prsystem.minibar_receipt ADD CHECK(kind IN ('OPENING','PURCHASE','CONSUMPTION','CONSUMPTION_REVERSAL'));
ALTER TABLE prsystem.minibar_receipt ADD CHECK((kind='OPENING' AND quantity>=0) OR(kind IN ('PURCHASE','CONSUMPTION_REVERSAL') AND quantity>0) OR(kind='CONSUMPTION' AND quantity<0));
ALTER TABLE prsystem.minibar_receipt ADD CHECK((kind IN ('CONSUMPTION','CONSUMPTION_REVERSAL'))=(room_id IS NOT NULL AND report_stay_id IS NOT NULL AND report_revision IS NOT NULL));
ALTER TABLE prsystem.minibar_receipt ADD CHECK(kind NOT IN ('OPENING','PURCHASE') OR (room_id IS NULL AND report_stay_id IS NULL AND report_revision IS NULL));
ALTER TABLE prsystem.minibar_receipt ADD CHECK((kind='CONSUMPTION_REVERSAL')=(original_receipt_id IS NOT NULL));
ALTER TABLE prsystem.minibar_transfer ADD COLUMN cost_denominator numeric NOT NULL DEFAULT 1 CHECK(cost_denominator>0 AND cost_denominator=trunc(cost_denominator));
ALTER TABLE prsystem.minibar_transfer ALTER COLUMN cost_value TYPE numeric;

CREATE OR REPLACE FUNCTION prsystem.minibar_room_quantity(t text,p text,r text DEFAULT NULL) RETURNS bigint LANGUAGE sql STABLE AS $$
 SELECT (coalesce((SELECT sum(CASE WHEN direction='REFILL' THEN quantity ELSE -quantity END)
 FROM prsystem.minibar_transfer WHERE tenant_id=t AND product_id=p AND (r IS NULL OR room_id=r)),0)
 +coalesce((SELECT sum(quantity) FROM prsystem.minibar_receipt WHERE tenant_id=t AND product_id=p
 AND kind IN ('CONSUMPTION','CONSUMPTION_REVERSAL') AND (r IS NULL OR room_id=r)),0))::bigint
$$;
CREATE OR REPLACE FUNCTION prsystem.guard_minibar_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE product prsystem.minibar_product%ROWTYPE; prior prsystem.minibar_receipt%ROWTYPE; original prsystem.minibar_receipt%ROWTYPE;
 n numeric; d numeric; room_before bigint; total_before bigint; delta_room bigint:=0;
BEGIN
 SELECT * INTO product FROM prsystem.minibar_product WHERE tenant_id=NEW.tenant_id AND id=NEW.product_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Missing inventory product' USING ERRCODE='23514'; END IF;
 SELECT * INTO prior FROM prsystem.minibar_receipt WHERE tenant_id=NEW.tenant_id AND product_id=NEW.product_id ORDER BY stock_revision DESC LIMIT 1;
 total_before:=coalesce(prior.total_quantity_after,0);n:=coalesce(prior.inventory_value_after,0);d:=coalesce(prior.inventory_value_denominator,1);
 IF NEW.kind IN ('OPENING','PURCHASE') THEN
  NEW.cost_numerator:=NEW.unit_cost_mnt;NEW.cost_denominator:=1;
  IF (NEW.kind='OPENING' AND NEW.unit_cost_mnt<>product.initial_unit_cost_mnt) OR (NEW.kind='PURCHASE' AND product.status<>'ACTIVE')
  THEN RAISE EXCEPTION 'Invalid receipt product' USING ERRCODE='23514'; END IF;
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
 SELECT coalesce(sum((x->>'target_quantity')::bigint),0) INTO target FROM jsonb_array_elements(req.target_snapshot->'items') x WHERE x->>'product_id'=NEW.product_id;
 IF (NEW.direction='REFILL' AND (target<=before_room OR NEW.quantity<>target-before_room OR NEW.quantity>before_wh))
 OR (NEW.direction='RETURN' AND (before_room<=target OR NEW.quantity<>before_room-target))
 OR NEW.room_after<>target OR NEW.warehouse_after<>before_wh+(CASE WHEN NEW.direction='RETURN' THEN NEW.quantity ELSE -NEW.quantity END)
 OR NEW.cost_value<>value OR NEW.cost_quantity<>total OR NEW.cost_denominator<>denominator
 THEN RAISE EXCEPTION 'Invalid bounded transfer' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
