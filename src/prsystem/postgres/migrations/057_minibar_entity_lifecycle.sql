-- Append-only intent/completion evidence; no inventory or guest-price mutation.
CREATE TABLE prsystem.minibar_lifecycle_intent (
 tenant_id text NOT NULL,id text NOT NULL,kind text NOT NULL CHECK(kind IN('product','template')),
 entity_id text NOT NULL,actor_id text NOT NULL,action text NOT NULL CHECK(action IN('DEACTIVATE','CANCEL_RETIRING','REACTIVATE')),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 before_snapshot jsonb NOT NULL,after_snapshot jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TABLE prsystem.minibar_lifecycle_completion (
 tenant_id text NOT NULL,intent_id text NOT NULL,system_actor text NOT NULL DEFAULT 'SYSTEM' CHECK(system_actor='SYSTEM'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,intent_id),FOREIGN KEY(tenant_id,intent_id) REFERENCES prsystem.minibar_lifecycle_intent
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_lifecycle_intent','minibar_lifecycle_completion'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;

CREATE FUNCTION prsystem.minibar_entity_blockers(t text,k text,e text)
RETURNS TABLE(kind text,source_id text) LANGUAGE sql STABLE AS $$
 SELECT 'ROOM_STOCK',r.id FROM prsystem.room r WHERE k='product' AND r.tenant_id=t
 AND prsystem.minibar_room_quantity(t,e,r.id)>0
 UNION ALL
 SELECT 'ACTIVE_TEMPLATE',v.template_id||':'||v.id FROM prsystem.minibar_template_version v
 JOIN prsystem.minibar_template p ON(p.tenant_id,p.id)=(v.tenant_id,v.template_id)
 WHERE k='product' AND v.tenant_id=t AND v.state='PUBLISHED' AND p.status='ACTIVE'
 AND EXISTS(SELECT 1 FROM jsonb_array_elements(v.published_items) x WHERE x->>'product_id'=e)
 UNION ALL
 SELECT 'CURRENT_ROOM',r.id FROM prsystem.room r JOIN prsystem.minibar_configuration_request q
 ON(q.tenant_id,q.id)=(r.tenant_id,r.minibar_application_id) WHERE r.tenant_id=t AND r.minibar_mode='ON'
 AND ((k='template' AND q.target_template_id=e) OR(k='product' AND EXISTS(
 SELECT 1 FROM jsonb_array_elements(q.target_snapshot->'items') x WHERE x->>'product_id'=e)))
 UNION ALL
 SELECT 'ACTIVE_STAY',s.id FROM prsystem.stay s WHERE s.tenant_id=t AND s.state='ACTIVE'
 AND ((k='template' AND s.snapshot->'minibar_snapshot'->>'template_id'=e) OR(k='product' AND EXISTS(
 SELECT 1 FROM jsonb_array_elements(s.snapshot->'minibar_snapshot'->'items') x WHERE x->>'product_id'=e)))
 UNION ALL
 SELECT 'PENDING_CONFIGURATION',q.id FROM prsystem.minibar_configuration_request q
 LEFT JOIN prsystem.minibar_configuration_request old ON old.tenant_id=q.tenant_id AND old.id=q.source_snapshot->>'application_id'
 WHERE q.tenant_id=t AND q.state NOT IN('APPLIED','CANCELLED') AND
 ((k='template' AND (q.target_template_id=e OR old.target_template_id=e)) OR(k='product' AND EXISTS(
 SELECT 1 FROM jsonb_array_elements(coalesce(q.target_snapshot->'items','[]')||coalesce(old.target_snapshot->'items','[]')) x WHERE x->>'product_id'=e)))
 UNION ALL
 SELECT 'PENDING_REFILL',q.id FROM prsystem.minibar_refill_request q
 JOIN prsystem.stay s ON(s.tenant_id,s.id)=(q.tenant_id,q.stay_id)
 WHERE q.tenant_id=t AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_refill_result z WHERE(z.tenant_id,z.request_id)=(q.tenant_id,q.id))
 AND ((k='product' AND q.product_id=e) OR(k='template' AND s.snapshot->'minibar_snapshot'->>'template_id'=e))
$$;

CREATE FUNCTION prsystem.complete_minibar_retirement(t text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE intent record; entity_status text; changed boolean;
BEGIN
 -- Only command-created retirements are swept; owner fixtures and other tenants
 -- cannot become implicit lifecycle requests.
 LOOP
 changed:=false;
 FOR intent IN SELECT DISTINCT ON(kind,entity_id) * FROM prsystem.minibar_lifecycle_intent
  WHERE tenant_id=t ORDER BY kind,entity_id,recorded_at DESC,id DESC LOOP
  IF intent.action<>'DEACTIVATE' OR intent.after_snapshot->>'status'<>'RETIRING'
  OR EXISTS(SELECT 1 FROM prsystem.minibar_lifecycle_completion WHERE tenant_id=t AND intent_id=intent.id) THEN CONTINUE; END IF;
  EXECUTE format('SELECT status FROM prsystem.minibar_%I WHERE tenant_id=$1 AND id=$2 FOR UPDATE',intent.kind) INTO entity_status USING t,intent.entity_id;
  IF entity_status='RETIRING' AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_entity_blockers(t,intent.kind,intent.entity_id)) THEN
   EXECUTE format('UPDATE prsystem.minibar_%I SET status=''INACTIVE'',revision=revision+1 WHERE tenant_id=$1 AND id=$2',intent.kind) USING t,intent.entity_id;
   INSERT INTO prsystem.minibar_lifecycle_completion(tenant_id,intent_id) VALUES(t,intent.id);
   changed:=true;
  END IF;
 END LOOP;
 EXIT WHEN NOT changed;
 END LOOP;
END; $$;

CREATE FUNCTION prsystem.wake_minibar_retirement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM prsystem.minibar_lifecycle_intent WHERE tenant_id=NEW.tenant_id AND action='DEACTIVATE' AND after_snapshot->>'status'='RETIRING')
 THEN PERFORM prsystem.complete_minibar_retirement(NEW.tenant_id); END IF;
 RETURN NULL;
END; $$;
-- Deferred wake-up sees final task, configuration, stay and stock state together.
CREATE CONSTRAINT TRIGGER wake_minibar_retirement AFTER INSERT ON prsystem.minibar_configuration_application
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.wake_minibar_retirement();
CREATE CONSTRAINT TRIGGER wake_minibar_retirement AFTER UPDATE ON prsystem.minibar_configuration_request
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.wake_minibar_retirement();
CREATE CONSTRAINT TRIGGER wake_minibar_retirement AFTER INSERT ON prsystem.minibar_refill_result
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.wake_minibar_retirement();
CREATE CONSTRAINT TRIGGER wake_minibar_retirement AFTER UPDATE ON prsystem.stay
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.wake_minibar_retirement();
CREATE CONSTRAINT TRIGGER wake_minibar_retirement AFTER UPDATE ON prsystem.minibar_template_version
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.wake_minibar_retirement();
CREATE CONSTRAINT TRIGGER wake_minibar_retirement AFTER INSERT ON prsystem.minibar_receipt
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.wake_minibar_retirement();
