-- Historical billing is independent of physical stock and immutable checkout.
CREATE TABLE prsystem.minibar_billing_correction (
 tenant_id text NOT NULL,stay_id text NOT NULL,id text NOT NULL,billing_revision bigint NOT NULL CHECK(billing_revision>0),
 original_revision bigint NOT NULL,previous_id text,original_charge_id text,charge_id text,
 finance_revision bigint NOT NULL,paid_mnt bigint NOT NULL CHECK(paid_mnt>=0),amount_mnt bigint NOT NULL CHECK(amount_mnt>=0),
 items jsonb NOT NULL,actor_id text NOT NULL,actor_label text NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,stay_id,id),UNIQUE(tenant_id,stay_id,billing_revision),
 FOREIGN KEY(tenant_id,stay_id,original_revision) REFERENCES prsystem.reception_minibar_report,
 FOREIGN KEY(tenant_id,stay_id,previous_id) REFERENCES prsystem.minibar_billing_correction(tenant_id,stay_id,id),
 FOREIGN KEY(tenant_id,stay_id,original_charge_id) REFERENCES prsystem.guest_charge(tenant_id,stay_id,id),
 FOREIGN KEY(tenant_id,stay_id,charge_id) REFERENCES prsystem.guest_charge(tenant_id,stay_id,id) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 CHECK((amount_mnt=0)=(charge_id IS NULL))
);
CREATE TABLE prsystem.minibar_billing_release (
 tenant_id text NOT NULL,stay_id text NOT NULL,correction_id text NOT NULL,allocation_id text NOT NULL,receipt_id text NOT NULL,
 amount_mnt bigint NOT NULL CHECK(amount_mnt>0),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,allocation_id),
 FOREIGN KEY(tenant_id,stay_id,correction_id) REFERENCES prsystem.minibar_billing_correction(tenant_id,stay_id,id),
 FOREIGN KEY(tenant_id,stay_id,allocation_id) REFERENCES prsystem.guest_allocation(tenant_id,stay_id,id),
 FOREIGN KEY(tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt(tenant_id,stay_id,id)
);
CREATE TABLE prsystem.minibar_billing_reallocation (LIKE prsystem.minibar_billing_release INCLUDING ALL);
ALTER TABLE prsystem.minibar_billing_reallocation ADD FOREIGN KEY(tenant_id,stay_id,correction_id) REFERENCES prsystem.minibar_billing_correction(tenant_id,stay_id,id);
ALTER TABLE prsystem.minibar_billing_reallocation ADD FOREIGN KEY(tenant_id,stay_id,allocation_id) REFERENCES prsystem.guest_allocation(tenant_id,stay_id,id);
ALTER TABLE prsystem.minibar_billing_reallocation ADD FOREIGN KEY(tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt(tenant_id,stay_id,id);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_billing_correction','minibar_billing_release','minibar_billing_reallocation'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('CREATE TRIGGER server_time BEFORE INSERT ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.stamp_minibar_adjustment_correction()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
CREATE FUNCTION prsystem.minibar_allocation_released(t text,allocation text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM prsystem.minibar_paid_release WHERE tenant_id=t AND allocation_id=allocation)
 OR EXISTS(SELECT 1 FROM prsystem.minibar_billing_release WHERE tenant_id=t AND allocation_id=allocation)
$$;
CREATE FUNCTION prsystem.minibar_receipt_released(t text,stay text,receipt text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM prsystem.minibar_paid_release WHERE tenant_id=t AND stay_id=stay AND receipt_id=receipt)
 OR EXISTS(SELECT 1 FROM prsystem.minibar_billing_release WHERE tenant_id=t AND stay_id=stay AND receipt_id=receipt)
$$;
CREATE FUNCTION prsystem.minibar_billing_basis(t text,stay text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE report prsystem.reception_minibar_report%ROWTYPE; latest prsystem.minibar_billing_correction%ROWTYPE; lines jsonb; waived boolean;
BEGIN
 SELECT r.* INTO report FROM prsystem.reception_minibar_report r JOIN prsystem.reception_minibar_inspection i
 ON(i.tenant_id,i.stay_id,i.revision)=(r.tenant_id,r.stay_id,r.revision)
 JOIN prsystem.minibar_guest_report g ON(g.tenant_id,g.stay_id,g.revision)=(r.tenant_id,r.stay_id,r.revision)
 JOIN prsystem.stay s ON(s.tenant_id,s.id)=(r.tenant_id,r.stay_id)
 JOIN prsystem.stay_checkout c ON(c.tenant_id,c.stay_id)=(s.tenant_id,s.id)
 WHERE r.tenant_id=t AND r.stay_id=stay AND i.state='REPORTED' AND s.state='CLOSED';
 IF report.stay_id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO latest FROM prsystem.minibar_billing_correction WHERE tenant_id=t AND stay_id=stay ORDER BY billing_revision DESC LIMIT 1;
 waived:=latest.id IS NULL AND EXISTS(SELECT 1 FROM prsystem.guest_charge_adjustment WHERE tenant_id=t AND charge_id=report.charge_id AND amount_mnt=-report.amount_mnt);
 SELECT jsonb_agg(jsonb_build_object('product_id',x->>'product_id','name',x->>'name','unit',x->>'unit','unit_price',x->'unit_price',
 'original_quantity',x->'used_quantity','billable_limit',coalesce((x->>'available_quantity')::bigint,(x->>'opening_quantity')::bigint+coalesce((x->>'refill_quantity')::bigint,0)),
 'quantity',coalesce((SELECT y->'quantity' FROM jsonb_array_elements(latest.items) y WHERE y->>'product_id'=x->>'product_id'),CASE WHEN waived THEN '0'::jsonb ELSE x->'used_quantity' END),
 'line_amount',coalesce((SELECT y->'line_amount' FROM jsonb_array_elements(latest.items) y WHERE y->>'product_id'=x->>'product_id'),CASE WHEN waived THEN '0'::jsonb ELSE x->'line_amount' END)) ORDER BY x->>'product_id') INTO lines FROM jsonb_array_elements(report.items) x;
 RETURN jsonb_build_object('original_revision',report.revision,'billing_revision',coalesce(latest.billing_revision,0),'previous_id',latest.id,
 'charge_id',CASE WHEN latest.id IS NULL THEN report.charge_id ELSE latest.charge_id END,
 'amount_mnt',coalesce(latest.amount_mnt,CASE WHEN waived THEN 0 ELSE report.amount_mnt END),'items',lines);
END; $$;
CREATE FUNCTION prsystem.minibar_billing_lines(t text,stay text,quantities jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE basis jsonb; entry jsonb; n bigint; lines jsonb:='[]';
BEGIN
 basis:=prsystem.minibar_billing_basis(t,stay);
 IF basis IS NULL OR jsonb_typeof(quantities) IS DISTINCT FROM 'object'
 OR (SELECT count(*) FROM jsonb_object_keys(quantities))<>jsonb_array_length(basis->'items') THEN RETURN NULL; END IF;
 FOR entry IN SELECT * FROM jsonb_array_elements(basis->'items') LOOP
  IF jsonb_typeof(quantities->(entry->>'product_id')) IS DISTINCT FROM 'number'
  OR (quantities->>(entry->>'product_id')) !~ '^[0-9]{1,7}$' THEN RETURN NULL; END IF;
  n:=(quantities->>(entry->>'product_id'))::bigint;
  IF n>1000000 OR n>(entry->>'billable_limit')::bigint THEN RETURN NULL; END IF;
  lines:=lines||jsonb_build_array(entry||jsonb_build_object('quantity',n,'line_amount',n*(entry->>'unit_price')::numeric));
 END LOOP;
 RETURN lines;
END; $$;
CREATE FUNCTION prsystem.guard_minibar_billing_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE basis jsonb; expected jsonb; quantities jsonb; paid bigint; net bigint; rev bigint; frozen boolean;
BEGIN
 PERFORM 1 FROM prsystem.stay WHERE tenant_id=NEW.tenant_id AND id=NEW.stay_id FOR UPDATE;
 SELECT revision,guest_finance.frozen INTO rev,frozen FROM prsystem.guest_finance WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id FOR UPDATE;
 PERFORM 1 FROM prsystem.staff_membership m JOIN prsystem.staff_account a ON a.id=m.account_id JOIN prsystem.hotel_access h ON h.tenant_id=m.tenant_id
 WHERE m.tenant_id=NEW.tenant_id AND m.account_id=NEW.actor_id AND m.status='ACTIVE' AND a.status='ACTIVE' AND a.verified_at IS NOT NULL
 AND NOT h.security_suspended AND h.package_mnt IN(25000,30000) AND('MANAGER'=ANY(m.roles) OR(h.package_mnt=30000 AND 'MANAGER_PLUS'=ANY(m.roles)))
 AND (clock_timestamp()<h.expires_at+interval '48 hours' OR EXISTS(SELECT 1 FROM prsystem.stay s WHERE s.tenant_id=NEW.tenant_id AND s.id=NEW.stay_id AND s.check_in_recorded_at<h.expires_at+interval '48 hours' AND s.check_in_recorded_at<=clock_timestamp())) FOR SHARE OF m,a,h;
 IF NOT FOUND OR frozen OR rev IS DISTINCT FROM NEW.finance_revision THEN RAISE EXCEPTION 'Invalid billing authority or finance revision' USING ERRCODE='23514'; END IF;
 basis:=prsystem.minibar_billing_basis(NEW.tenant_id,NEW.stay_id);
 SELECT jsonb_object_agg(x->>'product_id',x->'quantity') INTO quantities FROM jsonb_array_elements(NEW.items) x;
 expected:=prsystem.minibar_billing_lines(NEW.tenant_id,NEW.stay_id,quantities);
 SELECT paid_mnt,amount_mnt+coalesce((SELECT sum(amount_mnt) FROM prsystem.guest_charge_adjustment WHERE tenant_id=NEW.tenant_id AND charge_id=NEW.original_charge_id),0)
 INTO paid,net FROM prsystem.guest_charge WHERE tenant_id=NEW.tenant_id AND id=NEW.original_charge_id FOR UPDATE;
 IF basis IS NULL OR expected IS NULL OR NEW.items IS DISTINCT FROM expected OR NEW.items=basis->'items'
 OR NEW.original_revision IS DISTINCT FROM (basis->>'original_revision')::bigint OR NEW.billing_revision<>(basis->>'billing_revision')::bigint+1
 OR NEW.previous_id IS DISTINCT FROM basis->>'previous_id' OR NEW.original_charge_id IS DISTINCT FROM basis->>'charge_id'
 OR NEW.paid_mnt<>coalesce(paid,0) OR coalesce(net,0)<>(basis->>'amount_mnt')::bigint
 OR NEW.amount_mnt<>(SELECT sum((x->>'line_amount')::numeric) FROM jsonb_array_elements(expected) x)
 OR EXISTS(SELECT 1 FROM prsystem.guest_payment_intent p JOIN prsystem.guest_charge c ON(c.tenant_id,c.id)=(p.tenant_id,p.charge_id) WHERE p.tenant_id=NEW.tenant_id AND p.stay_id=NEW.stay_id AND c.kind='MINIBAR' AND p.state='PENDING')
 OR EXISTS(SELECT 1 FROM prsystem.guest_correction WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id AND state='PENDING')
 THEN RAISE EXCEPTION 'Invalid historical billing snapshot' USING ERRCODE='23514'; END IF;
 SELECT coalesce(nullif(display_name,''),email) INTO NEW.actor_label FROM prsystem.staff_account WHERE id=NEW.actor_id;
 RETURN NEW;
END; $$;
CREATE TRIGGER billing_guard BEFORE INSERT ON prsystem.minibar_billing_correction FOR EACH ROW EXECUTE FUNCTION prsystem.guard_minibar_billing_correction();
CREATE FUNCTION prsystem.prove_minibar_billing_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE correction prsystem.minibar_billing_correction%ROWTYPE; identity text;
BEGIN
 IF TG_TABLE_NAME='minibar_billing_correction' THEN identity:=NEW.id; ELSE identity:=NEW.correction_id; END IF;
 SELECT * INTO STRICT correction FROM prsystem.minibar_billing_correction WHERE tenant_id=NEW.tenant_id AND id=identity;
 IF (SELECT coalesce(sum(amount_mnt),0) FROM prsystem.minibar_billing_release WHERE tenant_id=correction.tenant_id AND correction_id=correction.id)<>correction.paid_mnt
 OR (SELECT coalesce(sum(amount_mnt),0) FROM prsystem.minibar_billing_reallocation WHERE tenant_id=correction.tenant_id AND correction_id=correction.id)<>least(correction.paid_mnt,correction.amount_mnt)
 OR (correction.charge_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM prsystem.guest_charge WHERE tenant_id=correction.tenant_id AND stay_id=correction.stay_id AND id=correction.charge_id
 AND kind='MINIBAR' AND source_id='billing:'||correction.id AND amount_mnt=correction.amount_mnt AND paid_mnt=least(correction.paid_mnt,correction.amount_mnt)))
 OR (correction.original_charge_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM prsystem.guest_charge c WHERE c.tenant_id=correction.tenant_id AND c.id=correction.original_charge_id AND c.paid_mnt=0
 AND c.amount_mnt+(SELECT coalesce(sum(a.amount_mnt),0) FROM prsystem.guest_charge_adjustment a WHERE a.tenant_id=c.tenant_id AND a.charge_id=c.id)=0))
 OR EXISTS(SELECT 1 FROM prsystem.minibar_billing_release x JOIN prsystem.guest_allocation a ON(a.tenant_id,a.id)=(x.tenant_id,x.allocation_id)
 WHERE x.tenant_id=correction.tenant_id AND x.correction_id=correction.id AND(a.charge_id IS DISTINCT FROM correction.original_charge_id OR a.receipt_id<>x.receipt_id OR a.amount_mnt<>x.amount_mnt
 OR EXISTS(SELECT 1 FROM prsystem.guest_allocation_reversal v WHERE v.tenant_id=a.tenant_id AND v.allocation_id=a.id)
 OR EXISTS(SELECT 1 FROM prsystem.minibar_paid_release v WHERE v.tenant_id=a.tenant_id AND v.allocation_id=a.id)))
 OR EXISTS(SELECT 1 FROM prsystem.minibar_billing_reallocation x JOIN prsystem.guest_allocation a ON(a.tenant_id,a.id)=(x.tenant_id,x.allocation_id)
 WHERE x.tenant_id=correction.tenant_id AND x.correction_id=correction.id AND(a.charge_id IS DISTINCT FROM correction.charge_id OR a.receipt_id<>x.receipt_id OR a.amount_mnt<>x.amount_mnt OR a.actor_id<>correction.actor_id))
 OR EXISTS(SELECT x.receipt_id FROM prsystem.minibar_billing_reallocation x WHERE x.tenant_id=correction.tenant_id AND x.correction_id=correction.id GROUP BY x.receipt_id
 HAVING sum(x.amount_mnt)>(SELECT coalesce(sum(r.amount_mnt),0) FROM prsystem.minibar_billing_release r WHERE r.tenant_id=correction.tenant_id AND r.correction_id=correction.id AND r.receipt_id=x.receipt_id))
 OR EXISTS(SELECT 1 FROM prsystem.guest_receipt r WHERE r.tenant_id=correction.tenant_id AND r.stay_id=correction.stay_id
 AND EXISTS(SELECT 1 FROM prsystem.minibar_billing_release x WHERE x.tenant_id=r.tenant_id AND x.receipt_id=r.id AND x.correction_id=correction.id)
 AND r.allocated<>(SELECT coalesce(sum(a.amount_mnt),0) FROM prsystem.guest_allocation a WHERE a.tenant_id=r.tenant_id AND a.receipt_id=r.id
 AND NOT prsystem.minibar_allocation_released(a.tenant_id,a.id) AND NOT EXISTS(SELECT 1 FROM prsystem.guest_allocation_reversal v WHERE v.tenant_id=a.tenant_id AND v.allocation_id=a.id)))
 THEN RAISE EXCEPTION 'Invalid historical billing ledger proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER billing_proof AFTER INSERT ON prsystem.minibar_billing_correction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_billing_correction();
CREATE CONSTRAINT TRIGGER billing_proof AFTER INSERT ON prsystem.minibar_billing_release DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_billing_correction();
CREATE CONSTRAINT TRIGGER billing_proof AFTER INSERT ON prsystem.minibar_billing_reallocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_billing_correction();
CREATE OR REPLACE FUNCTION prsystem.prove_guest_service_credit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected numeric; actual bigint;
BEGIN
 SELECT coalesce(sum(x.delta),0) INTO expected FROM (
 SELECT receipt_id,amount_mnt AS delta FROM prsystem.minibar_paid_release WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id
 UNION ALL SELECT receipt_id,-amount_mnt FROM prsystem.minibar_paid_reallocation WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id
 UNION ALL SELECT receipt_id,amount_mnt FROM prsystem.minibar_billing_release WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id
 UNION ALL SELECT receipt_id,-amount_mnt FROM prsystem.minibar_billing_reallocation WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id) x
 JOIN prsystem.guest_receipt r ON r.tenant_id=NEW.tenant_id AND r.id=x.receipt_id WHERE r.purpose='PAYMENT';
 SELECT service_credit INTO actual FROM prsystem.guest_finance WHERE tenant_id=NEW.tenant_id AND stay_id=NEW.stay_id;
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Service credit requires linked payment release' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER service_credit_proof AFTER INSERT ON prsystem.minibar_billing_correction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_guest_service_credit();
