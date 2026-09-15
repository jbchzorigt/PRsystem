-- Batch history needs SELECT/INSERT only. PostgreSQL row locks would require
-- UPDATE privileges, despite this manifest being immutable. A parent cannot
-- commit until its complete seal exists (migration 049 deferred proof), so an
-- external transaction never sees a mutable/unsealed parent. Existing sealed
-- parents reject additions; room locks still protect operational revisions.
CREATE OR REPLACE FUNCTION prsystem.guard_batch_rollout_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b prsystem.minibar_rollout_batch%ROWTYPE; rev bigint;
BEGIN
 IF NEW.rollout_batch_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO b FROM prsystem.minibar_rollout_batch WHERE tenant_id=NEW.tenant_id AND id=NEW.rollout_batch_id;
 SELECT revision INTO rev FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
 IF b.id IS NULL OR NEW.request_kind<>'ROLLOUT' OR NEW.target_mode<>'ON'
 OR (NEW.target_template_id,NEW.target_version_id,NEW.requested_by) IS DISTINCT FROM (b.template_id,b.version_id,b.requested_by)
 OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.selection) x WHERE x->>'room_id'=NEW.room_id AND (x->>'expected_room_revision')::numeric=rev)
 OR EXISTS(SELECT 1 FROM prsystem.minibar_rollout_seal WHERE tenant_id=NEW.tenant_id AND batch_id=b.id)
 THEN RAISE EXCEPTION 'Invalid batch child lineage' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION prsystem.guard_minibar_rollout_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b prsystem.minibar_rollout_batch%ROWTYPE; q prsystem.minibar_configuration_request%ROWTYPE; item jsonb;
BEGIN
 SELECT * INTO b FROM prsystem.minibar_rollout_batch WHERE tenant_id=NEW.tenant_id AND id=NEW.batch_id;
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

CREATE OR REPLACE FUNCTION prsystem.guard_minibar_rollout_seal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE n integer;
BEGIN
 SELECT jsonb_array_length(selection) INTO n FROM prsystem.minibar_rollout_batch WHERE tenant_id=NEW.tenant_id AND id=NEW.batch_id;
 IF n IS NULL OR n<>(SELECT count(*) FROM prsystem.minibar_rollout_result WHERE tenant_id=NEW.tenant_id AND batch_id=NEW.batch_id)
 OR EXISTS(SELECT 1 FROM prsystem.minibar_configuration_request q WHERE q.tenant_id=NEW.tenant_id AND q.rollout_batch_id=NEW.batch_id
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_rollout_result r WHERE r.tenant_id=q.tenant_id AND r.batch_id=q.rollout_batch_id AND r.child_id=q.id))
 THEN RAISE EXCEPTION 'Complete batch results required' USING ERRCODE='23514'; END IF;
 NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
