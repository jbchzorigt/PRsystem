-- One immutable source proves both sides of an atomic inventory correction.
CREATE TABLE prsystem.minibar_adjustment_correction (
 tenant_id text NOT NULL,id text NOT NULL,original_id text NOT NULL,
 reversal_id text NOT NULL,replacement_id text NOT NULL,actor_id text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,original_id),
 UNIQUE(tenant_id,reversal_id),UNIQUE(tenant_id,replacement_id),
 FOREIGN KEY(tenant_id,original_id) REFERENCES prsystem.minibar_adjustment,
 FOREIGN KEY(tenant_id,reversal_id) REFERENCES prsystem.minibar_adjustment DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,replacement_id) REFERENCES prsystem.minibar_adjustment DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id),
 CHECK(original_id<>reversal_id AND original_id<>replacement_id AND reversal_id<>replacement_id)
);
ALTER TABLE prsystem.minibar_adjustment_correction ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.minibar_adjustment_correction FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.minibar_adjustment_correction
 USING(tenant_id=current_setting('prsystem.tenant_id',true)) WITH CHECK(tenant_id=current_setting('prsystem.tenant_id',true));
REVOKE ALL ON prsystem.minibar_adjustment_correction FROM PUBLIC;
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON prsystem.minibar_adjustment_correction
 FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
ALTER TABLE prsystem.minibar_adjustment ADD COLUMN correction_id text;
ALTER TABLE prsystem.minibar_adjustment ADD FOREIGN KEY(tenant_id,correction_id) REFERENCES prsystem.minibar_adjustment_correction;

CREATE FUNCTION prsystem.stamp_minibar_adjustment_correction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.recorded_at=clock_timestamp(); RETURN NEW; END; $$;
CREATE TRIGGER stamp_correction BEFORE INSERT ON prsystem.minibar_adjustment_correction
 FOR EACH ROW EXECUTE FUNCTION prsystem.stamp_minibar_adjustment_correction();

CREATE FUNCTION prsystem.prove_minibar_adjustment_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c prsystem.minibar_adjustment_correction%ROWTYPE;
 o prsystem.minibar_adjustment%ROWTYPE;r prsystem.minibar_adjustment%ROWTYPE;n prsystem.minibar_adjustment%ROWTYPE;
 k text;
BEGIN
 IF TG_TABLE_NAME='minibar_adjustment_correction' THEN k=NEW.id; ELSE k=NEW.correction_id; END IF;
 IF k IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO STRICT c FROM prsystem.minibar_adjustment_correction WHERE tenant_id=NEW.tenant_id AND id=k;
 SELECT * INTO o FROM prsystem.minibar_adjustment WHERE tenant_id=c.tenant_id AND id=c.original_id;
 SELECT * INTO r FROM prsystem.minibar_adjustment WHERE tenant_id=c.tenant_id AND id=c.reversal_id;
 SELECT * INTO n FROM prsystem.minibar_adjustment WHERE tenant_id=c.tenant_id AND id=c.replacement_id;
 IF r.id IS NULL OR n.id IS NULL OR o.kind='REVERSAL' OR r.kind<>'REVERSAL' OR n.kind='REVERSAL'
 OR r.original_id IS DISTINCT FROM o.id OR n.original_id IS NOT NULL
 OR r.correction_id IS DISTINCT FROM c.id OR n.correction_id IS DISTINCT FROM c.id
 OR r.product_id IS DISTINCT FROM o.product_id OR n.product_id IS DISTINCT FROM o.product_id
 OR r.room_id IS DISTINCT FROM o.room_id OR n.room_id IS DISTINCT FROM o.room_id
 OR r.stay_id IS DISTINCT FROM o.stay_id OR n.stay_id IS DISTINCT FROM o.stay_id
 OR r.actor_id IS DISTINCT FROM c.actor_id OR n.actor_id IS DISTINCT FROM c.actor_id
 OR r.reason IS DISTINCT FROM c.reason OR n.reason IS DISTINCT FROM c.reason
 OR r.recorded_at<c.recorded_at OR n.recorded_at<r.recorded_at
 OR (SELECT count(*) FROM prsystem.minibar_adjustment WHERE tenant_id=c.tenant_id AND correction_id=c.id)<>2
 OR NOT EXISTS(SELECT 1 FROM prsystem.minibar_receipt a JOIN prsystem.minibar_receipt b
 ON b.tenant_id=a.tenant_id AND b.product_id=a.product_id AND b.stock_revision=a.stock_revision+1
 WHERE a.tenant_id=c.tenant_id AND a.id=r.receipt_id AND b.id=n.receipt_id)
 THEN RAISE EXCEPTION 'Correction requires linked reversal and replacement' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER prove_correction AFTER INSERT ON prsystem.minibar_adjustment_correction
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_adjustment_correction();
CREATE CONSTRAINT TRIGGER prove_correction AFTER INSERT ON prsystem.minibar_adjustment
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.prove_minibar_adjustment_correction();
