-- Original receipts/allocations remain immutable. Mutable totals are projections
-- of the linked reversal and replacement, posted on today's server timestamp.
CREATE TABLE prsystem.guest_correction (
    tenant_id text NOT NULL, stay_id text NOT NULL, id text NOT NULL,
    receipt_id text NOT NULL, replacement_amount_mnt bigint NOT NULL CHECK (replacement_amount_mnt>=0),
    requester_id text NOT NULL, shift_id text NOT NULL, drawer_id text NOT NULL,
    reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
    original_snapshot jsonb NOT NULL, requested_at timestamptz NOT NULL,
    state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','EXECUTED','REJECTED')),
    decider_id text, decision_reason text, decided_at timestamptz,
    PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,requester_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    FOREIGN KEY (tenant_id,decider_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    FOREIGN KEY (tenant_id,shift_id) REFERENCES prsystem.reception_shift,
    FOREIGN KEY (tenant_id,drawer_id) REFERENCES prsystem.cash_drawer,
    CHECK ((state='PENDING' AND decider_id IS NULL AND decision_reason IS NULL AND decided_at IS NULL)
        OR (state<>'PENDING' AND decider_id IS NOT NULL AND decision_reason IS NOT NULL AND decided_at IS NOT NULL AND length(btrim(decision_reason)) BETWEEN 1 AND 1000 AND decided_at>=requested_at))
);
CREATE UNIQUE INDEX one_pending_guest_correction ON prsystem.guest_correction (tenant_id,receipt_id) WHERE state='PENDING';
CREATE INDEX pending_guest_correction_shift ON prsystem.guest_correction (tenant_id,shift_id) WHERE state='PENDING';
CREATE TABLE prsystem.guest_receipt_reversal (
    tenant_id text NOT NULL, stay_id text NOT NULL, id text NOT NULL,
    correction_id text NOT NULL, receipt_id text NOT NULL, replacement_receipt_id text,
    amount_mnt bigint NOT NULL CHECK (amount_mnt>0), recorded_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,receipt_id), UNIQUE (tenant_id,correction_id),
    FOREIGN KEY (tenant_id,stay_id,correction_id) REFERENCES prsystem.guest_correction (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,stay_id,replacement_receipt_id) REFERENCES prsystem.guest_receipt (tenant_id,stay_id,id)
);
ALTER TABLE prsystem.guest_allocation ADD UNIQUE (tenant_id,stay_id,id);
CREATE TABLE prsystem.guest_allocation_reversal (
    tenant_id text NOT NULL, stay_id text NOT NULL, allocation_id text NOT NULL,
    correction_id text NOT NULL, amount_mnt bigint NOT NULL CHECK (amount_mnt>0), recorded_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id,allocation_id),
    FOREIGN KEY (tenant_id,stay_id,allocation_id) REFERENCES prsystem.guest_allocation (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,stay_id,correction_id) REFERENCES prsystem.guest_correction (tenant_id,stay_id,id)
);
CREATE FUNCTION prsystem.preserve_guest_correction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable correction' USING ERRCODE='23514'; END IF;
    IF OLD.state<>'PENDING' OR to_jsonb(NEW)-ARRAY['state','decider_id','decision_reason','decided_at']
        IS DISTINCT FROM to_jsonb(OLD)-ARRAY['state','decider_id','decision_reason','decided_at'] THEN
        RAISE EXCEPTION 'Immutable correction' USING ERRCODE='23514'; END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER guest_correction_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_correction
FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_guest_correction();
CREATE TRIGGER guest_receipt_reversal_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_receipt_reversal
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TRIGGER guest_allocation_reversal_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_allocation_reversal
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();

ALTER TABLE prsystem.cash_event DROP CONSTRAINT cash_event_kind_check;
ALTER TABLE prsystem.cash_event DROP CONSTRAINT cash_event_check;
ALTER TABLE prsystem.cash_event ADD CHECK (kind IN ('TRANSFER_RESERVED','TRANSFER_OUT','TRANSFER_IN','TRANSFER_CANCELLED',
    'CASH_DEBIT','INITIAL_FLOAT','GUEST_DEPOSIT_RECEIVED','GUEST_PAYMENT_RECEIVED','GUEST_REFUND_RESERVED','GUEST_REFUND_PAID','GUEST_REFUND_RELEASED','GUEST_CASH_CORRECTED'));
ALTER TABLE prsystem.cash_event ADD CHECK (
    (kind IN ('TRANSFER_RESERVED','GUEST_REFUND_RESERVED') AND posted_delta=0 AND reserved_delta>0) OR
    (kind IN ('TRANSFER_OUT','GUEST_REFUND_PAID') AND posted_delta<0 AND reserved_delta=posted_delta) OR
    (kind IN ('TRANSFER_IN','INITIAL_FLOAT','GUEST_DEPOSIT_RECEIVED','GUEST_PAYMENT_RECEIVED') AND posted_delta>0 AND reserved_delta=0) OR
    (kind IN ('TRANSFER_CANCELLED','GUEST_REFUND_RELEASED') AND posted_delta=0 AND reserved_delta<0) OR
    (kind='CASH_DEBIT' AND posted_delta<0 AND reserved_delta=0) OR
    (kind='GUEST_CASH_CORRECTED' AND reserved_delta=0));
REVOKE ALL ON prsystem.guest_correction,prsystem.guest_receipt_reversal,prsystem.guest_allocation_reversal FROM PUBLIC;
