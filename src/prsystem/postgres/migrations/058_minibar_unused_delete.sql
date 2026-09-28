-- Only entities with no business history or dependencies can be hard-deleted.
ALTER TABLE prsystem.minibar_lifecycle_intent DROP CONSTRAINT minibar_lifecycle_intent_action_check;
ALTER TABLE prsystem.minibar_lifecycle_intent ADD CHECK(action IN('DEACTIVATE','CANCEL_RETIRING','REACTIVATE','HARD_DELETE'));
CREATE FUNCTION prsystem.minibar_entity_unused(t text,k text,e text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM prsystem.minibar_lifecycle_intent WHERE tenant_id=t AND kind=k AND entity_id=e) THEN RETURN false; END IF;
 IF k='product' THEN
  RETURN EXISTS(SELECT 1 FROM prsystem.minibar_product WHERE tenant_id=t AND id=e)
  AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_receipt WHERE tenant_id=t AND product_id=e)
  AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_template_item WHERE tenant_id=t AND product_id=e)
  AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_transfer WHERE tenant_id=t AND product_id=e)
  AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_refill_request WHERE tenant_id=t AND product_id=e);
 ELSIF k='template' THEN
  RETURN EXISTS(SELECT 1 FROM prsystem.minibar_template WHERE tenant_id=t AND id=e AND default_version_id IS NULL)
  AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_template_version WHERE tenant_id=t AND template_id=e)
  AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request WHERE tenant_id=t AND target_template_id=e);
 END IF;
 RETURN false;
END; $$;
CREATE FUNCTION prsystem.guard_minibar_entity_delete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE k text:=replace(TG_TABLE_NAME,'minibar_','');
BEGIN
 IF NOT prsystem.minibar_entity_unused(OLD.tenant_id,k,OLD.id)
 THEN RAISE EXCEPTION 'Used entity must retain lifecycle history' USING ERRCODE='23514'; END IF;
 RETURN OLD;
END; $$;
CREATE FUNCTION prsystem.prove_minibar_entity_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_lifecycle_intent WHERE tenant_id=OLD.tenant_id
 AND kind=replace(TG_TABLE_NAME,'minibar_','') AND entity_id=OLD.id AND action='HARD_DELETE'
 AND before_snapshot->>'status'=OLD.status AND after_snapshot->>'status'='DELETED')
 THEN RAISE EXCEPTION 'Deletion requires immutable actor and reason evidence' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_product','minibar_template'] LOOP
  EXECUTE format('CREATE TRIGGER guard_unused_delete BEFORE DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_entity_delete()',tab);
  EXECUTE format('CREATE CONSTRAINT TRIGGER prove_unused_delete AFTER DELETE ON prsystem.%I DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_entity_delete()',tab);
 END LOOP;
END; $$;
