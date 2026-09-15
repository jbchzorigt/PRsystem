CREATE TABLE prsystem.guest_correction_route (
 tenant_id text NOT NULL,correction_id text NOT NULL,replacement_channel text NOT NULL CHECK(replacement_channel IN ('CASH','MANUAL_POS','QPAY','KHAAN')),
 proof jsonb NOT NULL,PRIMARY KEY(tenant_id,correction_id),FOREIGN KEY(tenant_id,correction_id) REFERENCES prsystem.guest_correction
);
CREATE TRIGGER correction_route_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_correction_route FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
ALTER TABLE prsystem.guest_payment_evidence ADD COLUMN correction_id text;
ALTER TABLE prsystem.guest_payment_evidence ADD FOREIGN KEY(tenant_id,correction_id) REFERENCES prsystem.guest_correction;
ALTER TABLE prsystem.guest_payment_evidence DROP CONSTRAINT guest_payment_evidence_check;
ALTER TABLE prsystem.guest_payment_evidence ADD CHECK(
 (provider='MANUAL_POS' AND terminal_id IS NOT NULL AND intent_id IS NULL) OR
 (provider<>'MANUAL_POS' AND terminal_id IS NULL AND num_nonnulls(intent_id,funding_id,correction_id)=1));
REVOKE ALL ON prsystem.guest_correction_route FROM PUBLIC;
