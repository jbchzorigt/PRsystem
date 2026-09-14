-- Keep the baseline query alias distinct from the PL/pgSQL count-loop variable.
CREATE OR REPLACE FUNCTION prsystem.minibar_shortage_plan(t text,request text) RETURNS jsonb LANGUAGE plpgsql AS $$
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
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(prsystem.minibar_configuration_baseline(t,request)) x WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(e.baseline) baseline_item WHERE baseline_item->>'product_id'=x->>'product_id'))
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
