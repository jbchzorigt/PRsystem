-- Count every product ever placed in the room, including adjustment-only stock.
CREATE OR REPLACE FUNCTION prsystem.minibar_configuration_baseline(t text,q text) RETURNS jsonb LANGUAGE sql STABLE AS $$
 WITH req AS(SELECT * FROM prsystem.minibar_configuration_request WHERE tenant_id=t AND id=q),
 products AS(SELECT x->>'product_id' id FROM req,jsonb_array_elements(target_snapshot->'items') x
 UNION SELECT m.product_id FROM prsystem.minibar_transfer m,req WHERE m.tenant_id=t AND m.room_id=req.room_id
 UNION SELECT a.product_id FROM prsystem.minibar_adjustment a,req WHERE a.tenant_id=t AND a.room_id=req.room_id)
 SELECT coalesce(jsonb_agg(jsonb_build_object('product_id',p.id,'name',p.name,'unit',p.unit,
 'quantity',prsystem.minibar_room_quantity(t,p.id,req.room_id)) ORDER BY p.id),'[]'::jsonb)
 FROM products JOIN prsystem.minibar_product p ON p.tenant_id=t AND p.id=products.id CROSS JOIN req
$$;
CREATE FUNCTION prsystem.minibar_adjustment_scope_ready(t text,p text,r text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT r IS NULL OR NOT EXISTS(
 SELECT 1 FROM prsystem.minibar_reconciliation e JOIN prsystem.minibar_configuration_request q
 ON(q.tenant_id,q.id)=(e.tenant_id,e.request_id)
 WHERE q.tenant_id=t AND q.room_id=r AND q.state NOT IN('APPLIED','CANCELLED')
 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.baseline) b WHERE b->>'product_id'=p))
$$;
CREATE FUNCTION prsystem.guard_minibar_adjustment_scope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.room_id IS NOT NULL THEN
  PERFORM id FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
  IF NOT prsystem.minibar_adjustment_scope_ready(NEW.tenant_id,NEW.product_id,NEW.room_id)
  THEN RAISE EXCEPTION 'New room product requires a new reconciliation count scope' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER adjustment_scope_guard BEFORE INSERT ON prsystem.minibar_adjustment FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_adjustment_scope();

CREATE OR REPLACE FUNCTION prsystem.minibar_counts_match(t text,q text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation WHERE tenant_id=t AND request_id=q)
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_reconciliation e,jsonb_array_elements(prsystem.minibar_configuration_baseline(t,q)) current_item
 WHERE e.tenant_id=t AND e.request_id=q AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.baseline) counted_item WHERE counted_item->>'product_id'=current_item->>'product_id'))
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
