-- B-07 / LIFE-DEC-003: package rights stay open during the 48-hour grace after expires_at,
-- matching subscription_gate and 070's billing guard (exclusive lock at expires_at+48h).

-- From 062; only the subscription check changed.
CREATE OR REPLACE FUNCTION prsystem.guard_minibar_adjustment() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st text; old prsystem.minibar_adjustment%ROWTYPE; roles text[]; pkg integer; sign integer;
BEGIN
 IF NEW.room_id IS NOT NULL THEN
  PERFORM id FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=NEW.room_id FOR UPDATE;
  SELECT id INTO st FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND room_id=NEW.room_id AND state='ACTIVE' FOR UPDATE;
  IF st IS DISTINCT FROM NEW.stay_id THEN RAISE EXCEPTION 'Current stay required' USING ERRCODE='23514'; END IF;
  IF prsystem.minibar_adjustment_report_locked(NEW.tenant_id,st)
  THEN RAISE EXCEPTION 'Posted report locks stock adjustment' USING ERRCODE='23514'; END IF;
 END IF;
 PERFORM id FROM prsystem.minibar_product WHERE tenant_id=NEW.tenant_id AND id=NEW.product_id FOR UPDATE;
 SELECT m.roles,h.package_mnt INTO roles,pkg FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
 JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id WHERE m.tenant_id=NEW.tenant_id AND m.account_id=NEW.actor_id
 AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.verified_at IS NOT NULL AND NOT h.security_suspended AND clock_timestamp()<h.expires_at+interval '48 hours';
 IF roles IS NULL OR pkg NOT IN(25000,30000) OR NOT('MANAGER'=ANY(roles) OR(pkg=30000 AND 'MANAGER_PLUS'=ANY(roles)))
 THEN RAISE EXCEPTION 'Current Manager required' USING ERRCODE='23514'; END IF;
 IF NEW.kind='REVERSAL' THEN
  SELECT * INTO old FROM prsystem.minibar_adjustment WHERE tenant_id=NEW.tenant_id AND id=NEW.original_id;
  IF old.kind='REVERSAL' OR old.id IS NULL OR (old.product_id,old.room_id,old.stay_id,old.quantity) IS DISTINCT FROM (NEW.product_id,NEW.room_id,NEW.stay_id,NEW.quantity)
  OR (NEW.hotel_delta,NEW.room_delta,NEW.billable_delta) IS DISTINCT FROM (-old.hotel_delta,-old.room_delta,-old.billable_delta)
  THEN RAISE EXCEPTION 'Invalid adjustment reversal' USING ERRCODE='23514'; END IF;
 ELSE
  sign:=CASE WHEN NEW.kind='COUNT_PLUS' THEN 1 ELSE -1 END;
  IF NEW.hotel_delta IS DISTINCT FROM (CASE WHEN NEW.kind='RETURN' THEN 0 ELSE sign*NEW.quantity END)
  OR NEW.room_delta IS DISTINCT FROM (CASE WHEN NEW.room_id IS NULL THEN 0 ELSE sign*NEW.quantity END)
  OR NEW.billable_delta IS DISTINCT FROM (CASE WHEN NEW.stay_id IS NULL OR NEW.kind='COUNT_PLUS' THEN 0 ELSE -NEW.quantity END)
  OR (NEW.kind='RETURN' AND NEW.room_id IS NULL)
  THEN RAISE EXCEPTION 'Invalid adjustment direction' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.room_id IS NOT NULL AND prsystem.minibar_room_quantity(NEW.tenant_id,NEW.product_id,NEW.room_id)+NEW.room_delta NOT BETWEEN 0 AND 1000000
 THEN RAISE EXCEPTION 'Invalid physical stock' USING ERRCODE='23514'; END IF;
 NEW.actor_roles:=roles;NEW.package_mnt:=pkg;NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;

-- From 066; only the subscription check changed.
CREATE OR REPLACE FUNCTION prsystem.minibar_variance_authorized(t text,actor text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id
 JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id WHERE m.tenant_id=t AND m.account_id=actor
 AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.verified_at IS NOT NULL AND NOT h.security_suspended
 AND clock_timestamp()<h.expires_at+interval '48 hours' AND h.package_mnt IN(25000,30000)
 AND('MANAGER'=ANY(m.roles) OR(h.package_mnt=30000 AND 'MANAGER_PLUS'=ANY(m.roles))))
$$;

-- From 074; only the subscription check changed.
CREATE OR REPLACE FUNCTION prsystem.guard_minibar_execution_step() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE q prsystem.minibar_configuration_request%ROWTYPE; e prsystem.minibar_reconciliation%ROWTYPE; b jsonb;
BEGIN
 SELECT * INTO q FROM prsystem.minibar_configuration_request WHERE tenant_id=NEW.tenant_id AND id=NEW.request_id FOR UPDATE;
 SELECT * INTO e FROM prsystem.minibar_reconciliation WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id;
 IF q.revision IS DISTINCT FROM NEW.request_revision OR NOT prsystem.minibar_safe_room(NEW.tenant_id,q.room_id,e.source_id)
 OR (NEW.kind='PARTIAL' AND q.state NOT IN('IN_PROGRESS','BLOCKED_STOCK','BLOCKED_VARIANCE'))
 OR (NEW.kind<>'PARTIAL' AND q.state<>'ROLLBACK_REQUIRED')
 OR NOT EXISTS(SELECT 1 FROM prsystem.cleaning_task t JOIN prsystem.staff_open_work w ON w.tenant_id=t.tenant_id AND w.source_id=t.id AND w.kind='CLEANING_TASK'
 JOIN prsystem.staff_membership m ON(m.tenant_id,m.account_id)=(t.tenant_id,t.assignee_id)
 JOIN prsystem.staff_account a ON a.id=m.account_id JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id
 WHERE t.tenant_id=NEW.tenant_id AND t.id=NEW.task_id AND t.source_id=e.source_id AND t.assignee_id=NEW.actor_id
 AND t.assignment_version=NEW.assignment_version AND t.state='OPEN' AND w.state='OPEN'
 AND m.status='ACTIVE' AND 'CLEANER'=ANY(m.roles) AND a.status='ACTIVE' AND a.verified_at IS NOT NULL
 AND h.package_mnt>=25000 AND NOT h.security_suspended AND clock_timestamp()<h.expires_at+interval '48 hours')
 THEN RAISE EXCEPTION 'Invalid current execution authority' USING ERRCODE='23514'; END IF;
 IF NEW.kind='ROLLBACK_COMPLETE' THEN
  IF (SELECT minibar_mode FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=q.room_id) IS DISTINCT FROM q.source_snapshot->>'mode'
  OR (SELECT minibar_application_id FROM prsystem.room WHERE tenant_id=NEW.tenant_id AND id=q.room_id) IS DISTINCT FROM q.source_snapshot->>'application_id'
  OR (SELECT count(*) FROM jsonb_object_keys(NEW.observed_counts))<>jsonb_array_length(e.baseline) THEN RAISE EXCEPTION 'Original configuration changed' USING ERRCODE='23514'; END IF;
  FOR b IN SELECT * FROM jsonb_array_elements(e.baseline) LOOP
   IF (NEW.observed_counts->> (b->>'product_id'))::bigint IS DISTINCT FROM (b->>'quantity')::bigint
   OR prsystem.minibar_room_quantity(NEW.tenant_id,b->>'product_id',q.room_id) IS DISTINCT FROM (b->>'quantity')::bigint
   THEN RAISE EXCEPTION 'Rollback baseline count required' USING ERRCODE='23514'; END IF;
  END LOOP;
 END IF;
 NEW.transaction_id:=pg_current_xact_id();NEW.recorded_at:=clock_timestamp();RETURN NEW;
END; $$;
