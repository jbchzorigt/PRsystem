CREATE TABLE prsystem.booking_hold_cancellation (
 tenant_id text NOT NULL,hold_id text NOT NULL,attempt_id text NOT NULL,
 outcome text NOT NULL CHECK(outcome='CANCELLED_GUEST'),
 captured_mnt bigint NOT NULL CHECK(captured_mnt>0),retained_mnt bigint NOT NULL CHECK(retained_mnt>=0),
 refund_due bigint NOT NULL CHECK(refund_due>=0),commission_mnt bigint NOT NULL CHECK(commission_mnt>=0),
 hotel_payable_mnt bigint NOT NULL CHECK(hotel_payable_mnt>=0),
 contract_snapshot jsonb NOT NULL,recorded_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,hold_id),
 FOREIGN KEY(tenant_id,hold_id) REFERENCES prsystem.booking_hold(tenant_id,id),
 FOREIGN KEY(tenant_id,hold_id,attempt_id) REFERENCES prsystem.booking_hold_attempt(tenant_id,hold_id,id),
 FOREIGN KEY(tenant_id,attempt_id) REFERENCES prsystem.booking_hold_capture(tenant_id,attempt_id),
 CHECK(retained_mnt+refund_due=captured_mnt),CHECK(commission_mnt+hotel_payable_mnt=retained_mnt)
);
CREATE TRIGGER booking_cancellation_immutable BEFORE UPDATE OR DELETE ON prsystem.booking_hold_cancellation
 FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
ALTER TABLE prsystem.booking_hold_cancellation ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.booking_hold_cancellation FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.booking_hold_cancellation
 USING(tenant_id=current_setting('prsystem.tenant_id',true))
 WITH CHECK(tenant_id=current_setting('prsystem.tenant_id',true));
REVOKE ALL ON prsystem.booking_hold_cancellation FROM PUBLIC;
