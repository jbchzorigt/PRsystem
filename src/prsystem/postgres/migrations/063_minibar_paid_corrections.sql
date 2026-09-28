CREATE TABLE prsystem.minibar_paid_correction (
 tenant_id text NOT NULL,stay_id text NOT NULL,id text NOT NULL,original_revision bigint NOT NULL,
 replacement_revision bigint NOT NULL,original_charge_id text NOT NULL,paid_mnt bigint NOT NULL CHECK(paid_mnt>0),
 actor_id text NOT NULL,reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),counts jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,stay_id,id),UNIQUE(tenant_id,stay_id,original_revision),
 CHECK(replacement_revision=original_revision+1),
 FOREIGN KEY(tenant_id,stay_id,original_revision) REFERENCES prsystem.reception_minibar_report,
 FOREIGN KEY(tenant_id,stay_id,replacement_revision) REFERENCES prsystem.reception_minibar_report DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,stay_id,original_charge_id) REFERENCES prsystem.guest_charge(tenant_id,stay_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TABLE prsystem.minibar_paid_release (
 tenant_id text NOT NULL,stay_id text NOT NULL,correction_id text NOT NULL,allocation_id text NOT NULL,
 receipt_id text NOT NULL,amount_mnt bigint NOT NULL CHECK(amount_mnt>0),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,allocation_id),
 FOREIGN KEY(tenant_id,stay_id,correction_id) REFERENCES prsystem.minibar_paid_correction(tenant_id,stay_id,id),
 FOREIGN KEY(tenant_id,stay_id,allocation_id) REFERENCES prsystem.guest_allocation(tenant_id,stay_id,id),
 FOREIGN KEY(tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt(tenant_id,stay_id,id)
);
CREATE TABLE prsystem.minibar_paid_reallocation (LIKE prsystem.minibar_paid_release INCLUDING ALL);
ALTER TABLE prsystem.minibar_paid_reallocation ADD FOREIGN KEY(tenant_id,stay_id,correction_id) REFERENCES prsystem.minibar_paid_correction(tenant_id,stay_id,id);
ALTER TABLE prsystem.minibar_paid_reallocation ADD FOREIGN KEY(tenant_id,stay_id,allocation_id) REFERENCES prsystem.guest_allocation(tenant_id,stay_id,id);
ALTER TABLE prsystem.minibar_paid_reallocation ADD FOREIGN KEY(tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt(tenant_id,stay_id,id);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['minibar_paid_correction','minibar_paid_release','minibar_paid_reallocation'] LOOP
  EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY tenant_scope ON prsystem.%I USING(tenant_id=current_setting(''prsystem.tenant_id'',true)) WITH CHECK(tenant_id=current_setting(''prsystem.tenant_id'',true))',tab);
  EXECUTE format('CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.%I FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation()',tab);
  EXECUTE format('REVOKE ALL ON prsystem.%I FROM PUBLIC',tab);
 END LOOP;
END; $$;
CREATE FUNCTION prsystem.prove_minibar_paid_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c prsystem.minibar_paid_correction%ROWTYPE; r prsystem.reception_minibar_report%ROWTYPE; k text;
BEGIN
 IF TG_TABLE_NAME='minibar_paid_correction' THEN k=NEW.id; ELSE k=NEW.correction_id; END IF;
 SELECT * INTO STRICT c FROM prsystem.minibar_paid_correction WHERE tenant_id=NEW.tenant_id AND id=k;
 SELECT * INTO r FROM prsystem.reception_minibar_report WHERE tenant_id=c.tenant_id AND stay_id=c.stay_id AND revision=c.replacement_revision;
 IF r.stay_id IS NULL OR r.actor_id<>c.actor_id OR r.reason IS DISTINCT FROM c.reason
 OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_manager_exception WHERE tenant_id=c.tenant_id AND stay_id=c.stay_id AND revision=c.replacement_revision AND actor_id=c.actor_id)
 OR NOT EXISTS(SELECT 1 FROM prsystem.reception_minibar_report WHERE tenant_id=c.tenant_id AND stay_id=c.stay_id AND revision=c.original_revision AND charge_id=c.original_charge_id)
 OR (SELECT jsonb_object_agg(x->>'product_id',x->'actual_count') FROM jsonb_array_elements(r.items) x) IS DISTINCT FROM c.counts
 OR (SELECT coalesce(sum(amount_mnt),0) FROM prsystem.minibar_paid_release WHERE tenant_id=c.tenant_id AND correction_id=c.id)<>c.paid_mnt
 OR (SELECT coalesce(sum(amount_mnt),0) FROM prsystem.minibar_paid_reallocation WHERE tenant_id=c.tenant_id AND correction_id=c.id)<>least(c.paid_mnt,r.amount_mnt)
 OR EXISTS(SELECT 1 FROM prsystem.minibar_paid_release x JOIN prsystem.guest_allocation a ON(a.tenant_id,a.id)=(x.tenant_id,x.allocation_id)
 WHERE x.tenant_id=c.tenant_id AND x.correction_id=c.id AND (a.stay_id<>c.stay_id OR a.charge_id<>c.original_charge_id OR a.receipt_id<>x.receipt_id OR a.amount_mnt<>x.amount_mnt
 OR EXISTS(SELECT 1 FROM prsystem.guest_allocation_reversal v WHERE v.tenant_id=a.tenant_id AND v.allocation_id=a.id)))
 OR EXISTS(SELECT 1 FROM prsystem.minibar_paid_reallocation x JOIN prsystem.guest_allocation a ON(a.tenant_id,a.id)=(x.tenant_id,x.allocation_id)
 WHERE x.tenant_id=c.tenant_id AND x.correction_id=c.id AND (a.stay_id<>c.stay_id OR a.charge_id IS DISTINCT FROM r.charge_id OR a.receipt_id<>x.receipt_id OR a.amount_mnt<>x.amount_mnt OR a.actor_id<>c.actor_id))
 OR EXISTS(SELECT receipt_id FROM prsystem.minibar_paid_reallocation WHERE tenant_id=c.tenant_id AND correction_id=c.id GROUP BY receipt_id
 HAVING sum(amount_mnt)>(SELECT coalesce(sum(amount_mnt),0) FROM prsystem.minibar_paid_release q WHERE q.tenant_id=c.tenant_id AND q.correction_id=c.id AND q.receipt_id=minibar_paid_reallocation.receipt_id))
 OR (r.charge_id IS NOT NULL AND (SELECT paid_mnt FROM prsystem.guest_charge WHERE tenant_id=c.tenant_id AND id=r.charge_id)<>least(c.paid_mnt,r.amount_mnt))
 OR EXISTS(SELECT 1 FROM prsystem.guest_receipt q WHERE q.tenant_id=c.tenant_id AND q.stay_id=c.stay_id
 AND EXISTS(SELECT 1 FROM prsystem.minibar_paid_release x WHERE x.tenant_id=q.tenant_id AND x.correction_id=c.id AND x.receipt_id=q.id)
 AND q.allocated<>(SELECT coalesce(sum(a.amount_mnt),0) FROM prsystem.guest_allocation a WHERE a.tenant_id=q.tenant_id AND a.receipt_id=q.id
 AND NOT EXISTS(SELECT 1 FROM prsystem.guest_allocation_reversal v WHERE v.tenant_id=a.tenant_id AND v.allocation_id=a.id)
 AND NOT EXISTS(SELECT 1 FROM prsystem.minibar_paid_release v WHERE v.tenant_id=a.tenant_id AND v.allocation_id=a.id)))
 OR (SELECT paid_mnt FROM prsystem.guest_charge WHERE tenant_id=c.tenant_id AND id=c.original_charge_id)<>0
 OR (SELECT coalesce(sum(amount_mnt),0) FROM prsystem.guest_charge_adjustment WHERE tenant_id=c.tenant_id AND charge_id=c.original_charge_id)<>(SELECT -amount_mnt FROM prsystem.guest_charge WHERE tenant_id=c.tenant_id AND id=c.original_charge_id)
 THEN RAISE EXCEPTION 'Invalid paid minibar correction proof' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER paid_correction_proof AFTER INSERT ON prsystem.minibar_paid_correction DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_paid_correction();
CREATE CONSTRAINT TRIGGER paid_correction_proof AFTER INSERT ON prsystem.minibar_paid_release DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_paid_correction();
CREATE CONSTRAINT TRIGGER paid_correction_proof AFTER INSERT ON prsystem.minibar_paid_reallocation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_paid_correction();
CREATE TRIGGER server_time BEFORE INSERT ON prsystem.minibar_paid_correction FOR EACH ROW EXECUTE FUNCTION prsystem.stamp_minibar_adjustment_correction();
CREATE TRIGGER server_time BEFORE INSERT ON prsystem.minibar_paid_release FOR EACH ROW EXECUTE FUNCTION prsystem.stamp_minibar_adjustment_correction();
CREATE TRIGGER server_time BEFORE INSERT ON prsystem.minibar_paid_reallocation FOR EACH ROW EXECUTE FUNCTION prsystem.stamp_minibar_adjustment_correction();
