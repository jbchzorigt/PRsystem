CREATE TABLE prsystem.room_lifecycle_intent (
 tenant_id text NOT NULL, id text NOT NULL, kind text NOT NULL CHECK(kind IN ('room','category')), entity_id text NOT NULL,
 actor_id text NOT NULL, action text NOT NULL, reason text NOT NULL, before_snapshot jsonb NOT NULL, after_snapshot jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TRIGGER room_lifecycle_intent_immutable BEFORE UPDATE OR DELETE ON prsystem.room_lifecycle_intent
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
-- Stage-five adapters own these source-bound holds. No public "clear blockers" command.
CREATE TABLE prsystem.reception_dependency_blocker (
 tenant_id text NOT NULL, room_id text NOT NULL, source_kind text NOT NULL, source_id text NOT NULL,
 state text NOT NULL CHECK(state IN ('OPEN','DONE')), PRIMARY KEY(tenant_id,source_kind,source_id),
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room
);
CREATE TABLE prsystem.room_lifecycle_completion (
 tenant_id text NOT NULL, intent_id text NOT NULL, system_actor text NOT NULL DEFAULT 'SYSTEM',
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,intent_id),
 FOREIGN KEY(tenant_id,intent_id) REFERENCES prsystem.room_lifecycle_intent
);
CREATE TRIGGER room_lifecycle_completion_immutable BEFORE UPDATE OR DELETE ON prsystem.room_lifecycle_completion
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE FUNCTION prsystem.room_blockers(p_tenant text,p_room text) RETURNS text[] LANGUAGE sql STABLE AS $$
 SELECT array_remove(ARRAY[
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.stay WHERE tenant_id=p_tenant AND room_id=p_room AND state='ACTIVE') THEN 'ACTIVE_STAY' END,
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room_cleaning_request WHERE tenant_id=p_tenant AND room_id=p_room AND state='OPEN') THEN 'CLEANING' END,
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room r WHERE r.tenant_id=p_tenant AND r.id=p_room AND r.cleaning_state<>'CLEAN'
 AND EXISTS(SELECT 1 FROM prsystem.stay s WHERE s.tenant_id=p_tenant AND s.room_id=p_room AND s.state='CLOSED')) THEN 'CHECKOUT_REPORT' END,
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room_reservation WHERE tenant_id=p_tenant AND room_id=p_room AND state='CONFIRMED' AND planned_checkout_at>clock_timestamp()) THEN 'BOOKING' END,
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.reception_dependency_blocker WHERE tenant_id=p_tenant AND room_id=p_room AND state='OPEN') THEN 'DEPENDENCY' END
 ],NULL);
$$;
CREATE FUNCTION prsystem.category_blockers(p_tenant text,p_category text) RETURNS text[] LANGUAGE sql STABLE AS $$
 SELECT array_remove(ARRAY[
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room WHERE tenant_id=p_tenant AND category_id=p_category AND status<>'INACTIVE') THEN 'ACTIVE_ROOMS' END,
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room r JOIN prsystem.stay s ON(s.tenant_id,s.room_id)=(r.tenant_id,r.id)
 WHERE r.tenant_id=p_tenant AND r.category_id=p_category AND s.state='ACTIVE') THEN 'ACTIVE_STAY' END,
 CASE WHEN EXISTS(SELECT 1 FROM prsystem.room r JOIN prsystem.room_reservation b ON(b.tenant_id,b.room_id)=(r.tenant_id,r.id)
 WHERE r.tenant_id=p_tenant AND r.category_id=p_category AND b.state='CONFIRMED' AND b.planned_checkout_at>clock_timestamp()) THEN 'BOOKING' END
 ],NULL);
$$;
-- Called after canonical source completion in the same room/catalog transaction.
CREATE FUNCTION prsystem.complete_room_retirement(p_tenant text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE item record; request_id text;
BEGIN
 FOR item IN SELECT id FROM prsystem.room WHERE tenant_id=p_tenant AND status='RETIRING' ORDER BY id FOR UPDATE LOOP
  IF cardinality(prsystem.room_blockers(p_tenant,item.id))=0 THEN
   SELECT id INTO request_id FROM prsystem.room_lifecycle_intent WHERE tenant_id=p_tenant AND kind='room' AND entity_id=item.id AND action='DEACTIVATE' ORDER BY recorded_at DESC,id DESC LIMIT 1;
   IF request_id IS NOT NULL THEN
    UPDATE prsystem.room SET status='INACTIVE',revision=revision+1 WHERE tenant_id=p_tenant AND id=item.id;
    INSERT INTO prsystem.room_lifecycle_completion(tenant_id,intent_id) VALUES(p_tenant,request_id) ON CONFLICT DO NOTHING;
   END IF;
  END IF;
 END LOOP;
 FOR item IN SELECT id FROM prsystem.room_category WHERE tenant_id=p_tenant AND status='RETIRING' ORDER BY id FOR UPDATE LOOP
  IF cardinality(prsystem.category_blockers(p_tenant,item.id))=0 THEN
   SELECT id INTO request_id FROM prsystem.room_lifecycle_intent WHERE tenant_id=p_tenant AND kind='category' AND entity_id=item.id AND action='DEACTIVATE' ORDER BY recorded_at DESC,id DESC LIMIT 1;
   IF request_id IS NOT NULL THEN
    UPDATE prsystem.room_category SET status='INACTIVE',revision=revision+1 WHERE tenant_id=p_tenant AND id=item.id;
    INSERT INTO prsystem.room_lifecycle_completion(tenant_id,intent_id) VALUES(p_tenant,request_id) ON CONFLICT DO NOTHING;
   END IF;
  END IF;
 END LOOP;
END; $$;
REVOKE ALL ON prsystem.room_lifecycle_intent,prsystem.room_lifecycle_completion,prsystem.reception_dependency_blocker FROM PUBLIC;
REVOKE ALL ON FUNCTION prsystem.room_blockers(text,text),prsystem.category_blockers(text,text),prsystem.complete_room_retirement(text) FROM PUBLIC;
