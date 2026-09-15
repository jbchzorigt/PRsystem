-- Future category capacity uses current configuration, not a future price book.
-- Actual arrival still requires minibar_guest_opening and physical readiness.
CREATE FUNCTION prsystem.minibar_booking_eligible(t text,r text) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
DECLARE room prsystem.room%ROWTYPE;
BEGIN
 SELECT * INTO room FROM prsystem.room WHERE tenant_id=t AND id=r;
 IF NOT FOUND OR room.status<>'ACTIVE' OR NOT EXISTS(SELECT 1 FROM prsystem.room_category
  WHERE tenant_id=t AND id=room.category_id AND status='ACTIVE') THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM prsystem.reception_dependency_blocker WHERE tenant_id=t AND room_id=r
  AND state='OPEN' AND (source_kind<>'CANONICAL_MINIBAR' OR room.minibar_mode<>'ON')) THEN RETURN false; END IF;
 IF room.minibar_mode='OFF' THEN RETURN true; END IF;
 IF room.minibar_mode<>'ON' THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM prsystem.hotel_access WHERE tenant_id=t AND package_mnt IN(25000,30000))
  OR EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request WHERE tenant_id=t AND room_id=r
   AND state NOT IN('APPLIED','CANCELLED')) THEN RETURN false; END IF;
 RETURN EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request q
  JOIN prsystem.minibar_configuration_application a ON(a.tenant_id,a.request_id,a.room_id)=(q.tenant_id,q.id,q.room_id)
  JOIN prsystem.minibar_template p ON(p.tenant_id,p.id)=(q.tenant_id,q.target_template_id)
  JOIN prsystem.minibar_template_version v ON(v.tenant_id,v.template_id,v.id)=(q.tenant_id,q.target_template_id,q.target_version_id)
  WHERE q.tenant_id=t AND q.id=room.minibar_application_id AND q.room_id=r
  AND q.state='APPLIED' AND q.target_mode='ON' AND p.status='ACTIVE' AND v.state='PUBLISHED'
  AND jsonb_array_length(q.target_snapshot->'items')>0
  AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(q.target_snapshot->'items') x
   LEFT JOIN prsystem.minibar_product product ON product.tenant_id=t AND product.id=x->>'product_id'
   WHERE product.status IS DISTINCT FROM 'ACTIVE'));
END; $$;
