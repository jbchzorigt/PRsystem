-- Template authoring only. Publishing never assigns a room or moves stock.
CREATE TABLE prsystem.minibar_template (
 tenant_id text NOT NULL REFERENCES prsystem.hotel_access,
 id text NOT NULL,
 name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','RETIRING','INACTIVE')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
 default_version_id text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE prsystem.minibar_template_version (
 tenant_id text NOT NULL,
 template_id text NOT NULL,
 id text NOT NULL,
 version_number bigint NOT NULL CHECK(version_number>0),
 state text NOT NULL DEFAULT 'DRAFT' CHECK(state IN ('DRAFT','PUBLISHED')),
 cloned_from_id text,
 published_items jsonb,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 published_at timestamptz,
 PRIMARY KEY(tenant_id,template_id,id),
 UNIQUE(tenant_id,template_id,version_number),
 FOREIGN KEY(tenant_id,template_id) REFERENCES prsystem.minibar_template(tenant_id,id),
 FOREIGN KEY(tenant_id,template_id,cloned_from_id) REFERENCES prsystem.minibar_template_version(tenant_id,template_id,id),
 CHECK((state='PUBLISHED')=(published_at IS NOT NULL)),
 CHECK((state='PUBLISHED')=(published_items IS NOT NULL))
);
ALTER TABLE prsystem.minibar_template ADD CONSTRAINT minibar_template_default_fk
 FOREIGN KEY(tenant_id,id,default_version_id) REFERENCES prsystem.minibar_template_version(tenant_id,template_id,id)
 DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE prsystem.minibar_template_item (
 tenant_id text NOT NULL,
 template_id text NOT NULL,
 version_id text NOT NULL,
 product_id text NOT NULL,
 target_quantity bigint NOT NULL CHECK(target_quantity>0),
 PRIMARY KEY(tenant_id,template_id,version_id,product_id),
 FOREIGN KEY(tenant_id,template_id,version_id) REFERENCES prsystem.minibar_template_version(tenant_id,template_id,id),
 FOREIGN KEY(tenant_id,product_id) REFERENCES prsystem.minibar_product(tenant_id,id)
);

CREATE FUNCTION prsystem.guard_minibar_template_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item prsystem.minibar_template_item%ROWTYPE; version_state text;
BEGIN
 IF TG_OP='DELETE' THEN item:=OLD; ELSE item:=NEW; END IF;
 IF TG_OP='UPDATE' AND (NEW.tenant_id,NEW.template_id,NEW.version_id,NEW.product_id)
   IS DISTINCT FROM (OLD.tenant_id,OLD.template_id,OLD.version_id,OLD.product_id)
 THEN RAISE EXCEPTION 'Immutable template item identity' USING ERRCODE='23514'; END IF;
 PERFORM 1 FROM prsystem.minibar_template WHERE tenant_id=item.tenant_id AND id=item.template_id FOR UPDATE;
 SELECT state INTO version_state FROM prsystem.minibar_template_version
 WHERE tenant_id=item.tenant_id AND template_id=item.template_id AND id=item.version_id FOR UPDATE;
 IF version_state IS DISTINCT FROM 'DRAFT' THEN
   RAISE EXCEPTION 'Immutable published template items' USING ERRCODE='23514';
 END IF;
 IF TG_OP='INSERT' AND (SELECT count(*) FROM prsystem.minibar_template_item
   WHERE tenant_id=item.tenant_id AND template_id=item.template_id AND version_id=item.version_id)>=100
 THEN RAISE EXCEPTION 'Template item limit' USING ERRCODE='23514'; END IF;
 RETURN item;
END; $$;
CREATE TRIGGER minibar_template_item_guard BEFORE INSERT OR UPDATE OR DELETE ON prsystem.minibar_template_item
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_template_item();

CREATE FUNCTION prsystem.guard_minibar_template_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_state text; snapshot jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Template history retained' USING ERRCODE='23514'; END IF;
 IF TG_OP='INSERT' THEN
   IF NEW.state<>'DRAFT' THEN RAISE EXCEPTION 'Create a draft first' USING ERRCODE='23514'; END IF;
   RETURN NEW;
 END IF;
 IF OLD.state<>'DRAFT' OR (NEW.tenant_id,NEW.template_id,NEW.id,NEW.version_number,NEW.cloned_from_id,NEW.created_at)
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
CREATE TRIGGER minibar_template_version_guard BEFORE INSERT OR UPDATE OR DELETE ON prsystem.minibar_template_version
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_template_version();

-- Deferred final-state check permits first publish + default in one transaction.
CREATE FUNCTION prsystem.check_minibar_template_default() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant text; template text; chosen text; has_published boolean;
BEGIN
 tenant:=NEW.tenant_id;
 IF TG_TABLE_NAME='minibar_template' THEN template:=NEW.id; ELSE template:=NEW.template_id; END IF;
 SELECT default_version_id INTO chosen FROM prsystem.minibar_template WHERE tenant_id=tenant AND id=template;
 SELECT EXISTS(SELECT 1 FROM prsystem.minibar_template_version
   WHERE tenant_id=tenant AND template_id=template AND state='PUBLISHED') INTO has_published;
 IF has_published<>(chosen IS NOT NULL) OR (chosen IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM prsystem.minibar_template_version WHERE tenant_id=tenant AND template_id=template AND id=chosen AND state='PUBLISHED'))
 THEN RAISE EXCEPTION 'Exactly one published default required' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER minibar_template_default_check AFTER INSERT OR UPDATE ON prsystem.minibar_template
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.check_minibar_template_default();
CREATE CONSTRAINT TRIGGER minibar_version_default_check AFTER INSERT OR UPDATE ON prsystem.minibar_template_version
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.check_minibar_template_default();

DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_template','minibar_template_version','minibar_template_item'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
