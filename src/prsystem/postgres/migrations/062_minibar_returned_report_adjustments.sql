-- An explicitly returned, unpaid inspection can reconcile non-guest stock.
-- Paid or pending-payment reports stay locked even if inspection state is stale.
CREATE FUNCTION prsystem.minibar_adjustment_report_locked(t text,s text) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
BEGIN
 IF s IS NULL OR NOT EXISTS(SELECT 1 FROM prsystem.reception_minibar_report WHERE tenant_id=t AND stay_id=s) THEN RETURN false; END IF;
 IF NOT EXISTS(SELECT 1 FROM prsystem.reception_minibar_inspection WHERE tenant_id=t AND stay_id=s AND state='REQUESTED') THEN RETURN true; END IF;
 RETURN EXISTS(SELECT 1 FROM prsystem.guest_charge c WHERE c.tenant_id=t AND c.stay_id=s AND c.kind='MINIBAR'
 AND(c.paid_mnt>0 OR EXISTS(SELECT 1 FROM prsystem.guest_payment_intent p WHERE p.tenant_id=t AND p.charge_id=c.id AND p.state='PENDING')));
END; $$;
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
 AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.verified_at IS NOT NULL AND NOT h.security_suspended AND h.expires_at>clock_timestamp();
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
