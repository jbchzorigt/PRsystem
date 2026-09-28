-- Category reservation becomes physical stay occupancy atomically.
CREATE TABLE prsystem.booking_hold_application (
 tenant_id text NOT NULL, hold_id text NOT NULL, stay_id text NOT NULL,
 attempt_id text NOT NULL, amount_mnt bigint NOT NULL CHECK(amount_mnt>0),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,hold_id), UNIQUE(tenant_id,stay_id),
 FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_hold(tenant_id,id),
 FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay(tenant_id,id),
 FOREIGN KEY(tenant_id,hold_id,attempt_id) REFERENCES prsystem.booking_hold_attempt(tenant_id,hold_id,id),
 FOREIGN KEY(tenant_id,attempt_id) REFERENCES prsystem.booking_hold_capture(tenant_id,attempt_id)
);
CREATE TRIGGER booking_application_immutable BEFORE UPDATE OR DELETE ON prsystem.booking_hold_application
 FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
ALTER TABLE prsystem.booking_hold_application ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.booking_hold_application FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.booking_hold_application
 USING(tenant_id=current_setting('prsystem.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('prsystem.tenant_id',true));
REVOKE ALL ON prsystem.booking_hold_application FROM PUBLIC;
