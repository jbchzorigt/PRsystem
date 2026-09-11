-- Archive is a terminal version transition; it never moves stock or room pointers.
ALTER TABLE prsystem.minibar_template_version DROP CONSTRAINT minibar_template_version_state_check;
ALTER TABLE prsystem.minibar_template_version DROP CONSTRAINT minibar_template_version_check;
ALTER TABLE prsystem.minibar_template_version DROP CONSTRAINT minibar_template_version_check1;
ALTER TABLE prsystem.minibar_template_version ADD CHECK(state IN ('DRAFT','PUBLISHED','ARCHIVED'));
ALTER TABLE prsystem.minibar_template_version ADD CHECK((state IN ('PUBLISHED','ARCHIVED'))=(published_at IS NOT NULL));
ALTER TABLE prsystem.minibar_template_version ADD CHECK((state IN ('PUBLISHED','ARCHIVED'))=(published_items IS NOT NULL));

CREATE TABLE prsystem.minibar_version_archive (
 tenant_id text NOT NULL,template_id text NOT NULL,version_id text NOT NULL,
 actor_id text NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,template_id,version_id),
 FOREIGN KEY(tenant_id,template_id,version_id) REFERENCES prsystem.minibar_template_version,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
ALTER TABLE prsystem.minibar_version_archive ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.minibar_version_archive FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.minibar_version_archive
 USING(tenant_id=current_setting('prsystem.tenant_id',true)) WITH CHECK(tenant_id=current_setting('prsystem.tenant_id',true));
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.minibar_version_archive
 FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.minibar_version_archive FROM PUBLIC;

CREATE FUNCTION prsystem.minibar_version_archive_blockers(t text,p text,v text)
RETURNS TABLE(kind text,source_id text) LANGUAGE sql STABLE AS $$
 SELECT 'DEFAULT',id FROM prsystem.minibar_template WHERE tenant_id=t AND id=p AND default_version_id=v
 UNION ALL
 SELECT 'CURRENT_ROOM',r.id FROM prsystem.room r JOIN prsystem.minibar_configuration_request q
 ON(q.tenant_id,q.id)=(r.tenant_id,r.minibar_application_id)
 WHERE r.tenant_id=t AND r.minibar_mode='ON' AND q.target_template_id=p AND q.target_version_id=v
 UNION ALL
 SELECT 'PENDING_TARGET',q.id FROM prsystem.minibar_configuration_request q
 WHERE q.tenant_id=t AND q.state NOT IN ('APPLIED','CANCELLED') AND q.target_template_id=p AND q.target_version_id=v
 UNION ALL
 SELECT 'PENDING_SOURCE',q.id FROM prsystem.minibar_configuration_request q JOIN prsystem.minibar_configuration_request old
 ON old.tenant_id=q.tenant_id AND old.id=q.source_snapshot->>'application_id'
 WHERE q.tenant_id=t AND q.state NOT IN ('APPLIED','CANCELLED') AND old.target_template_id=p AND old.target_version_id=v
 UNION ALL
 SELECT 'ACTIVE_STAY',s.id FROM prsystem.stay s WHERE s.tenant_id=t AND s.state='ACTIVE'
 AND s.snapshot->'minibar_snapshot'->>'template_id'=p AND s.snapshot->'minibar_snapshot'->>'version_id'=v
 UNION ALL
 SELECT 'CLEANER_TASK',c.id FROM prsystem.cleaning_task c JOIN prsystem.minibar_reconciliation e
 ON(e.tenant_id,e.source_id)=(c.tenant_id,c.source_id)
 JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(e.tenant_id,e.request_id)
 LEFT JOIN prsystem.minibar_configuration_request old ON old.tenant_id=q.tenant_id AND old.id=q.source_snapshot->>'application_id'
 WHERE c.tenant_id=t AND c.state='OPEN' AND ((q.target_template_id=p AND q.target_version_id=v)
 OR(old.target_template_id=p AND old.target_version_id=v))
$$;
CREATE FUNCTION prsystem.guard_minibar_version_archive() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_state text;
BEGIN
 PERFORM 1 FROM prsystem.minibar_template WHERE tenant_id=NEW.tenant_id AND id=NEW.template_id FOR UPDATE;
 SELECT state INTO version_state FROM prsystem.minibar_template_version
 WHERE tenant_id=NEW.tenant_id AND template_id=NEW.template_id AND id=NEW.version_id FOR UPDATE;
 IF version_state IS DISTINCT FROM 'PUBLISHED' OR EXISTS(
 SELECT 1 FROM prsystem.minibar_version_archive_blockers(NEW.tenant_id,NEW.template_id,NEW.version_id))
 THEN RAISE EXCEPTION 'Version not eligible for archive' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER minibar_version_archive_guard BEFORE INSERT ON prsystem.minibar_version_archive
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_version_archive();
CREATE OR REPLACE FUNCTION prsystem.guard_minibar_template_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_state text; snapshot jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Template history retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'DRAFT' THEN RAISE EXCEPTION 'Create a draft first' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF OLD.state='PUBLISHED' AND NEW.state='ARCHIVED' THEN
   IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state')
      OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_version_archive WHERE tenant_id=NEW.tenant_id AND template_id=NEW.template_id AND version_id=NEW.id)
      OR EXISTS(SELECT 1 FROM prsystem.minibar_version_archive_blockers(NEW.tenant_id,NEW.template_id,NEW.id))
   THEN RAISE EXCEPTION 'Archive proof and no live references required' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF OLD.state<>'DRAFT' OR NEW.state NOT IN ('DRAFT','PUBLISHED') OR (NEW.tenant_id,NEW.template_id,NEW.id,NEW.version_number,NEW.cloned_from_id,NEW.created_at)
    IS DISTINCT FROM (OLD.tenant_id,OLD.template_id,OLD.id,OLD.version_number,OLD.cloned_from_id,OLD.created_at)
 THEN RAISE EXCEPTION 'Immutable template version' USING ERRCODE='23514'; END IF;
 IF NEW.state='PUBLISHED' THEN
   SELECT status INTO parent_state FROM prsystem.minibar_template
     WHERE tenant_id=NEW.tenant_id AND id=NEW.template_id FOR UPDATE;
   PERFORM 1 FROM prsystem.minibar_product p JOIN prsystem.minibar_template_item i
     ON p.tenant_id=i.tenant_id AND p.id=i.product_id
     WHERE i.tenant_id=NEW.tenant_id AND i.template_id=NEW.template_id AND i.version_id=NEW.id
     ORDER BY p.id FOR SHARE OF p;
   IF parent_state IS DISTINCT FROM 'ACTIVE' OR EXISTS(
     SELECT 1 FROM prsystem.minibar_template_item i JOIN prsystem.minibar_product p
       ON p.tenant_id=i.tenant_id AND p.id=i.product_id
     WHERE i.tenant_id=NEW.tenant_id AND i.template_id=NEW.template_id AND i.version_id=NEW.id AND p.status<>'ACTIVE')
   THEN RAISE EXCEPTION 'Template not eligible' USING ERRCODE='23514'; END IF;
   SELECT jsonb_agg(jsonb_build_object('product_id',p.id,'name',p.name,'unit',p.unit,
      'target_quantity',i.target_quantity) ORDER BY p.id) INTO snapshot
     FROM prsystem.minibar_template_item i JOIN prsystem.minibar_product p
       ON p.tenant_id=i.tenant_id AND p.id=i.product_id
     WHERE i.tenant_id=NEW.tenant_id AND i.template_id=NEW.template_id AND i.version_id=NEW.id;
   IF snapshot IS NULL THEN RAISE EXCEPTION 'Empty template' USING ERRCODE='23514'; END IF;
   NEW.published_items:=snapshot; NEW.published_at:=clock_timestamp();
 END IF;
 RETURN NEW;
END; $$;

CREATE FUNCTION prsystem.apply_minibar_version_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE prsystem.minibar_template_version SET state='ARCHIVED'
 WHERE tenant_id=NEW.tenant_id AND template_id=NEW.template_id AND id=NEW.version_id;
 RETURN NULL;
END; $$;
CREATE TRIGGER minibar_version_archive_apply AFTER INSERT ON prsystem.minibar_version_archive
 FOR EACH ROW EXECUTE FUNCTION prsystem.apply_minibar_version_archive();

-- Additive exact-version reference contract for the future canonical stay adapter.
-- Existing OFF and isolated MOCK_ON snapshots contain no canonical version IDs.
CREATE FUNCTION prsystem.guard_stay_minibar_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p text; v text; version_state text;
BEGIN
 p:=NEW.snapshot->'minibar_snapshot'->>'template_id'; v:=NEW.snapshot->'minibar_snapshot'->>'version_id';
 IF p IS NOT NULL OR v IS NOT NULL THEN
   PERFORM 1 FROM prsystem.minibar_template WHERE tenant_id=NEW.tenant_id AND id=p FOR SHARE;
   SELECT state INTO version_state FROM prsystem.minibar_template_version
     WHERE tenant_id=NEW.tenant_id AND template_id=p AND id=v FOR SHARE;
   IF version_state IS NULL OR (NEW.state='ACTIVE' AND version_state<>'PUBLISHED')
   THEN RAISE EXCEPTION 'Invalid exact stay minibar version' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER stay_minibar_version_guard BEFORE INSERT ON prsystem.stay
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_stay_minibar_version();
