-- REQ-26-05.00 / RML-DEC-003: a category with a live category-level online booking
-- (same predicate as booking_inventory.claims) cannot become INACTIVE.
-- booking_hold* tables force tenant RLS: callers must set prsystem.tenant_id first.
CREATE OR REPLACE FUNCTION prsystem.category_blockers(p_tenant text,p_category text) RETURNS text[] LANGUAGE sql STABLE AS $$
 SELECT array_remove(ARRAY[
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room WHERE tenant_id=p_tenant AND category_id=p_category AND status<>'INACTIVE') THEN 'ACTIVE_ROOMS' END,
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room r JOIN prsystem.stay s ON(s.tenant_id,s.room_id)=(r.tenant_id,r.id)
 WHERE r.tenant_id=p_tenant AND r.category_id=p_category AND s.state='ACTIVE') THEN 'ACTIVE_STAY' END,
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room r JOIN prsystem.room_reservation b ON(b.tenant_id,b.room_id)=(r.tenant_id,r.id)
 WHERE r.tenant_id=p_tenant AND r.category_id=p_category AND b.state='CONFIRMED' AND b.planned_checkout_at>clock_timestamp())
 OR EXISTS(SELECT 1 FROM prsystem.booking_hold h WHERE h.tenant_id=p_tenant AND h.category_id=p_category
 AND h.hold_state IN ('ACTIVE','CONSUMED') AND h.planned_checkout_at>clock_timestamp()
 AND NOT EXISTS(SELECT 1 FROM prsystem.booking_hold_application a WHERE (a.tenant_id,a.hold_id)=(h.tenant_id,h.id))
 AND NOT EXISTS(SELECT 1 FROM prsystem.booking_hold_cancellation x WHERE (x.tenant_id,x.hold_id)=(h.tenant_id,h.id))) THEN 'BOOKING' END
 ],NULL);
$$;
