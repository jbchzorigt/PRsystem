-- Bounded confirmation manifests; operational progress remains on each room request.
CREATE TABLE prsystem.minibar_rollout_batch (
 tenant_id text NOT NULL,id text NOT NULL,template_id text NOT NULL,version_id text NOT NULL,
 retry_of_batch_id text,selection jsonb NOT NULL CHECK(jsonb_typeof(selection)='array'),
 target_snapshot jsonb NOT NULL,requested_by text NOT NULL,command_key text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),
 FOREIGN KEY(tenant_id,template_id,version_id) REFERENCES prsystem.minibar_template_version,
 FOREIGN KEY(tenant_id,requested_by) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 FOREIGN KEY(tenant_id,retry_of_batch_id) REFERENCES prsystem.minibar_rollout_batch
);
ALTER TABLE prsystem.minibar_configuration_request ADD COLUMN rollout_batch_id text;
ALTER TABLE prsystem.minibar_configuration_request ADD FOREIGN KEY(tenant_id,rollout_batch_id)
 REFERENCES prsystem.minibar_rollout_batch;
CREATE TABLE prsystem.minibar_rollout_result (
 tenant_id text NOT NULL,batch_id text NOT NULL,room_id text NOT NULL,child_id text,
 disposition text NOT NULL CHECK(disposition IN ('ACCEPTED','SKIPPED')),
 code text,initial_state text,room_snapshot jsonb NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,batch_id,room_id),UNIQUE(tenant_id,child_id),
 FOREIGN KEY(tenant_id,batch_id) REFERENCES prsystem.minibar_rollout_batch,
 FOREIGN KEY(tenant_id,child_id) REFERENCES prsystem.minibar_configuration_request,
 CHECK((disposition='ACCEPTED' AND child_id IS NOT NULL AND code IS NULL AND initial_state IN ('SCHEDULED_AFTER_STAY','READY_FOR_RECONCILIATION'))
    OR(disposition='SKIPPED' AND child_id IS NULL AND code IS NOT NULL AND initial_state IS NULL))
);
CREATE TABLE prsystem.minibar_rollout_seal (
 tenant_id text NOT NULL,batch_id text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,batch_id),FOREIGN KEY(tenant_id,batch_id) REFERENCES prsystem.minibar_rollout_batch
);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_rollout_batch','minibar_rollout_result','minibar_rollout_seal'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
CREATE FUNCTION prsystem.guard_minibar_rollout_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent prsystem.minibar_template%ROWTYPE; version prsystem.minibar_template_version%ROWTYPE;
 old_batch prsystem.minibar_rollout_batch%ROWTYPE; n integer; item jsonb;
BEGIN
 n:=jsonb_array_length(NEW.selection);
 IF n NOT BETWEEN (CASE WHEN NEW.retry_of_batch_id IS NULL THEN 2 ELSE 1 END) AND 100
 OR n<>(SELECT count(DISTINCT x->>'room_id') FROM jsonb_array_elements(NEW.selection) x)
 THEN RAISE EXCEPTION 'Bounded unique room selection required' USING ERRCODE='23514'; END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(NEW.selection) LOOP
  IF jsonb_typeof(item)<>'object' OR coalesce(length(btrim(item->>'room_id')),0) NOT BETWEEN 1 AND 128
  OR jsonb_typeof(item->'expected_room_revision') IS DISTINCT FROM 'number'
  OR (item->>'expected_room_revision')::numeric NOT BETWEEN 0 AND 9223372036854775807
  OR (item->>'expected_room_revision')::numeric<>trunc((item->>'expected_room_revision')::numeric)
  THEN RAISE EXCEPTION 'Invalid selection item' USING ERRCODE='23514'; END IF;
 END LOOP;
 SELECT * INTO parent FROM prsystem.minibar_template WHERE tenant_id=NEW.tenant_id AND id=NEW.template_id FOR UPDATE;
 SELECT * INTO version FROM prsystem.minibar_template_version WHERE tenant_id=NEW.tenant_id AND template_id=NEW.template_id AND id=NEW.version_id FOR SHARE;
 PERFORM 1 FROM prsystem.minibar_product p JOIN prsystem.minibar_template_item i ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id)
  WHERE i.tenant_id=NEW.tenant_id AND i.template_id=NEW.template_id AND i.version_id=NEW.version_id ORDER BY p.id FOR SHARE OF p;
 IF parent.status IS DISTINCT FROM 'ACTIVE' OR version.state IS DISTINCT FROM 'PUBLISHED'
 OR EXISTS(SELECT 1 FROM prsystem.minibar_template_item i JOIN prsystem.minibar_product p ON(p.tenant_id,p.id)=(i.tenant_id,i.product_id)
 WHERE i.tenant_id=NEW.tenant_id AND i.template_id=NEW.template_id AND i.version_id=NEW.version_id AND p.status<>'ACTIVE')
 THEN RAISE EXCEPTION 'Ineligible batch target' USING ERRCODE='23514'; END IF;
 IF NEW.retry_of_batch_id IS NOT NULL THEN
  SELECT * INTO old_batch FROM prsystem.minibar_rollout_batch WHERE tenant_id=NEW.tenant_id AND id=NEW.retry_of_batch_id;
  IF NOT FOUND OR (old_batch.template_id,old_batch.version_id) IS DISTINCT FROM (NEW.template_id,NEW.version_id)
  OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_rollout_seal WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.retry_of_batch_id)
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.selection) x WHERE NOT EXISTS(
    SELECT 1 FROM prsystem.minibar_rollout_result r LEFT JOIN prsystem.minibar_configuration_request q ON(q.tenant_id,q.id)=(r.tenant_id,r.child_id)
    WHERE r.tenant_id=NEW.tenant_id AND r.batch_id=NEW.retry_of_batch_id AND r.room_id=x->>'room_id' AND (r.disposition='SKIPPED' OR q.state='CANCELLED')))
  THEN RAISE EXCEPTION 'Invalid batch retry' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.target_snapshot:=jsonb_build_object('template_id',parent.id,'template_name',parent.name,'version_id',version.id,'version_number',version.version_number,'items',version.published_items);
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER batch_manifest_guard BEFORE INSERT ON prsystem.minibar_rollout_batch
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_rollout_batch();
CREATE FUNCTION prsystem.guard_batch_rollout_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b prsystem.minibar_rollout_batch%ROWTYPE; rev bigint;
BEGIN
 IF NEW.rollout_batch_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO b FROM prsystem.minibar_rollout_batch WHERE tenant_id=NEW.tenant_id AND id=NEW.rollout_batch_id FOR SHARE;
 SELECT revision INTO rev FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
 IF b.id IS NULL OR NEW.request_kind<>'ROLLOUT' OR NEW.target_mode<>'ON'
 OR (NEW.target_template_id,NEW.target_version_id,NEW.requested_by) IS DISTINCT FROM (b.template_id,b.version_id,b.requested_by)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.selection) x WHERE x->>'room_id'=NEW.room_id AND (x->>'expected_room_revision')::numeric=rev)
 OR EXISTS(SELECT 1 FROM prsystem.minibar_rollout_seal WHERE tenant_id=NEW.tenant_id AND batch_id=b.id)
 THEN RAISE EXCEPTION 'Invalid batch child lineage' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER batch_rollout_child_guard BEFORE INSERT ON prsystem.minibar_configuration_request
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_batch_rollout_child();
CREATE FUNCTION prsystem.guard_minibar_rollout_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b prsystem.minibar_rollout_batch%ROWTYPE; q prsystem.minibar_configuration_request%ROWTYPE; item jsonb;
BEGIN
 SELECT * INTO b FROM prsystem.minibar_rollout_batch WHERE tenant_id=NEW.tenant_id AND id=NEW.batch_id FOR UPDATE;
 SELECT x INTO item FROM jsonb_array_elements(b.selection) x WHERE x->>'room_id'=NEW.room_id;
 IF item IS NULL OR EXISTS(SELECT 1 FROM prsystem.minibar_rollout_seal WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.batch_id)
 THEN RAISE EXCEPTION 'Sealed or unselected batch result' USING ERRCODE='23514'; END IF;
 IF NEW.child_id IS NOT NULL THEN
  SELECT * INTO q FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.child_id;
  IF q.id IS NULL OR (q.rollout_batch_id,q.room_id) IS DISTINCT FROM (NEW.batch_id,NEW.room_id)
  THEN RAISE EXCEPTION 'Wrong batch child' USING ERRCODE='23514'; END IF;
  NEW.initial_state:=q.state;
 END IF;
 NEW.room_snapshot:=jsonb_build_object('room_number',(SELECT number FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id),'expected_room_revision',item->'expected_room_revision');
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER batch_result_guard BEFORE INSERT ON prsystem.minibar_rollout_result
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_rollout_result();
CREATE FUNCTION prsystem.guard_minibar_rollout_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
 SELECT jsonb_array_length(selection) INTO n FROM prsystem.minibar_rollout_batch WHERE tenant_id=NEW.tenant_id AND id=NEW.batch_id FOR UPDATE;
 IF n IS NULL OR n<>(SELECT count(*) FROM prsystem.minibar_rollout_result WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.batch_id)
 OR EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request q WHERE q.tenant_id=NEW.tenant_id AND q.rollout_batch_id=NEW.batch_id
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_rollout_result r WHERE r.tenant_id=q.tenant_id AND r.batch_id=q.rollout_batch_id AND r.child_id=q.id))
 THEN RAISE EXCEPTION 'Complete batch results required' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
CREATE TRIGGER batch_seal_guard BEFORE INSERT ON prsystem.minibar_rollout_seal
 FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_rollout_seal();
CREATE FUNCTION prsystem.require_minibar_rollout_seal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.minibar_rollout_seal WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.id)
 OR NOT EXISTS(SELECT 1 FROM prsystem.staff_command_receipt r WHERE r.tenant_id=NEW.tenant_id AND r.key=NEW.command_key AND r.actor_id=NEW.requested_by
 AND r.command->>'action'='MINIBAR_ROLLOUT_BATCH_CONFIRM' AND r.result->>'batch_id'=NEW.id)
 OR NOT EXISTS(SELECT 1 FROM prsystem.operational_event e WHERE e.tenant_id=NEW.tenant_id AND e.source_id=NEW.id
 AND e.actor_id=NEW.requested_by AND e.kind='MINIBAR_ROLLOUT_BATCH_CONFIRMED')
 THEN RAISE EXCEPTION 'Unsealed batch cannot commit' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER batch_complete_guard AFTER INSERT ON prsystem.minibar_rollout_batch
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.require_minibar_rollout_seal();
