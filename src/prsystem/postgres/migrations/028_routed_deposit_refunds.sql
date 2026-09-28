ALTER TABLE prsystem.guest_refund DROP CONSTRAINT guest_refund_channel_check;
ALTER TABLE prsystem.guest_refund ADD CHECK(channel IN ('CASH','MANUAL_POS','QPAY','KHAAN'));
CREATE TABLE prsystem.guest_refund_route (
 tenant_id text NOT NULL,refund_id text NOT NULL,original_channel text NOT NULL,recipient_envelope jsonb NOT NULL,
 reason text NOT NULL,approval text NOT NULL CHECK(approval IN ('PENDING','APPROVED','REJECTED')),
 approver_id text,approval_reason text,approved_at timestamptz,
 sent_at timestamptz,provider_reference text,last_provider_state text NOT NULL DEFAULT 'NOT_SENT',
 PRIMARY KEY(tenant_id,refund_id),FOREIGN KEY(tenant_id,refund_id) REFERENCES prsystem.guest_refund,
 FOREIGN KEY(tenant_id,approver_id) REFERENCES prsystem.staff_membership(tenant_id,account_id)
);
CREATE TABLE prsystem.refund_provider_evidence (
 tenant_id text NOT NULL,refund_id text NOT NULL,provider text NOT NULL,merchant_id text NOT NULL,reference text NOT NULL,
 amount_mnt bigint NOT NULL CHECK(amount_mnt>0),confirmed_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,refund_id),UNIQUE(provider,merchant_id,reference),
 FOREIGN KEY(tenant_id,refund_id) REFERENCES prsystem.guest_refund
);
CREATE TRIGGER refund_evidence_immutable BEFORE UPDATE OR DELETE ON prsystem.refund_provider_evidence FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.late_refund_case (
 tenant_id text NOT NULL,refund_id text NOT NULL,provider_reference text NOT NULL,amount_mnt bigint NOT NULL CHECK(amount_mnt>0),
 state text NOT NULL DEFAULT 'OPEN' CHECK(state IN ('OPEN','RECONCILING','PROVIDER_STATUS_CORRECTED_NOT_SUCCESS','PROVIDER_SUCCESS_POSTED')),
 claimant_id text REFERENCES prsystem.platform_account,resolver_id text REFERENCES prsystem.platform_account,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),resolved_at timestamptz,reason text,
 PRIMARY KEY(tenant_id,refund_id),FOREIGN KEY(tenant_id,refund_id) REFERENCES prsystem.guest_refund
);
CREATE TABLE prsystem.late_refund_posting (
 tenant_id text NOT NULL,refund_id text NOT NULL,kind text NOT NULL CHECK(kind IN ('LATE_REFUND_COVERED','LATE_REFUND_SHORTFALL')),
 amount_mnt bigint NOT NULL CHECK(amount_mnt>0),resolver_id text NOT NULL REFERENCES prsystem.platform_account,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,refund_id,kind),
 FOREIGN KEY(tenant_id,refund_id) REFERENCES prsystem.late_refund_case
);
CREATE TRIGGER late_refund_posting_immutable BEFORE UPDATE OR DELETE ON prsystem.late_refund_posting FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE FUNCTION prsystem.preserve_late_refund_case() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable refund case' USING ERRCODE='23514'; END IF;
 IF OLD.state IN ('PROVIDER_STATUS_CORRECTED_NOT_SUCCESS','PROVIDER_SUCCESS_POSTED') OR
 (to_jsonb(NEW)-ARRAY['state','claimant_id','resolver_id','resolved_at','reason']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['state','claimant_id','resolver_id','resolved_at','reason']) THEN RAISE EXCEPTION 'Immutable refund case' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER late_refund_case_immutable BEFORE UPDATE OR DELETE ON prsystem.late_refund_case FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_late_refund_case();
REVOKE ALL ON prsystem.guest_refund_route,prsystem.refund_provider_evidence,prsystem.late_refund_case,prsystem.late_refund_posting FROM PUBLIC;
CREATE FUNCTION prsystem.preserve_refund_route() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable refund route' USING ERRCODE='23514'; END IF;
 IF (to_jsonb(NEW)-ARRAY['approval','approver_id','approval_reason','approved_at','sent_at','provider_reference','last_provider_state']) IS DISTINCT FROM
 (to_jsonb(OLD)-ARRAY['approval','approver_id','approval_reason','approved_at','sent_at','provider_reference','last_provider_state']) OR
 (OLD.approval<>'PENDING' AND ROW(NEW.approval,NEW.approver_id,NEW.approval_reason,NEW.approved_at) IS DISTINCT FROM ROW(OLD.approval,OLD.approver_id,OLD.approval_reason,OLD.approved_at)) OR
 (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at) OR
 (OLD.provider_reference IS NOT NULL AND NEW.provider_reference IS DISTINCT FROM OLD.provider_reference) THEN
 RAISE EXCEPTION 'Immutable refund route' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER refund_route_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_refund_route FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_refund_route();
