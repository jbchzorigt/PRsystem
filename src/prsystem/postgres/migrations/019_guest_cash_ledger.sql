-- Authoritative deposit settings are explicit, versioned and independent of the
-- legacy room-category catalog field (which accepted invalid/zero amounts).
CREATE TABLE prsystem.deposit_hotel_settings (
    tenant_id text PRIMARY KEY REFERENCES prsystem.hotel_access,
    amount_mnt bigint NOT NULL CHECK (amount_mnt BETWEEN 50000 AND 100000),
    revision bigint NOT NULL CHECK (revision>0)
);
CREATE TABLE prsystem.deposit_category_settings (
    tenant_id text NOT NULL, category_id text NOT NULL,
    amount_mnt bigint CHECK (amount_mnt BETWEEN 50000 AND 100000),
    revision bigint NOT NULL CHECK (revision>0),
    PRIMARY KEY (tenant_id,category_id),
    FOREIGN KEY (tenant_id,category_id) REFERENCES prsystem.room_category
);
CREATE TABLE prsystem.guest_finance (
    tenant_id text NOT NULL, stay_id text NOT NULL, revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    received bigint NOT NULL DEFAULT 0 CHECK (received>=0),
    reversed bigint NOT NULL DEFAULT 0 CHECK (reversed>=0),
    allocated bigint NOT NULL DEFAULT 0 CHECK (allocated>=0),
    refund_reserved bigint NOT NULL DEFAULT 0 CHECK (refund_reserved>=0),
    refunded bigint NOT NULL DEFAULT 0 CHECK (refunded>=0),
    frozen boolean NOT NULL DEFAULT false,
    PRIMARY KEY (tenant_id,stay_id),
    FOREIGN KEY (tenant_id,stay_id) REFERENCES prsystem.stay,
    CHECK (received::numeric-reversed-allocated-refund_reserved-refunded>=0)
);
CREATE TABLE prsystem.guest_charge (
    tenant_id text NOT NULL, stay_id text NOT NULL, id text NOT NULL,
    kind text NOT NULL CHECK (kind='ROOM'), source_id text NOT NULL,
    amount_mnt bigint NOT NULL CHECK (amount_mnt>0),
    paid_mnt bigint NOT NULL DEFAULT 0 CHECK (paid_mnt>=0 AND paid_mnt<=amount_mnt),
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,stay_id,id), UNIQUE (tenant_id,kind,source_id),
    FOREIGN KEY (tenant_id,stay_id) REFERENCES prsystem.guest_finance
);
CREATE TABLE prsystem.guest_receipt (
    tenant_id text NOT NULL, stay_id text NOT NULL, id text NOT NULL,
    purpose text NOT NULL CHECK (purpose IN ('DEPOSIT','PAYMENT')),
    channel text NOT NULL CHECK (channel='CASH'),
    amount_mnt bigint NOT NULL CHECK (amount_mnt>0),
    allocated bigint NOT NULL DEFAULT 0 CHECK (allocated>=0),
    refund_reserved bigint NOT NULL DEFAULT 0 CHECK (refund_reserved>=0),
    refunded bigint NOT NULL DEFAULT 0 CHECK (refunded>=0),
    reversed bigint NOT NULL DEFAULT 0 CHECK (reversed>=0),
    actor_id text NOT NULL, shift_id text NOT NULL, drawer_id text NOT NULL,
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id,id), UNIQUE (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,stay_id) REFERENCES prsystem.guest_finance,
    FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    FOREIGN KEY (tenant_id,shift_id) REFERENCES prsystem.reception_shift,
    FOREIGN KEY (tenant_id,drawer_id) REFERENCES prsystem.cash_drawer,
    CHECK (amount_mnt::numeric-allocated-refund_reserved-refunded-reversed>=0)
);
CREATE TABLE prsystem.guest_allocation (
    tenant_id text NOT NULL, stay_id text NOT NULL, id text NOT NULL,
    receipt_id text NOT NULL, charge_id text NOT NULL,
    amount_mnt bigint NOT NULL CHECK (amount_mnt>0), actor_id text NOT NULL, recorded_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,stay_id,charge_id) REFERENCES prsystem.guest_charge (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership (tenant_id,account_id)
);
CREATE TABLE prsystem.guest_refund (
    tenant_id text NOT NULL, stay_id text NOT NULL, id text NOT NULL,
    receipt_id text NOT NULL, amount_mnt bigint NOT NULL CHECK (amount_mnt>0),
    channel text NOT NULL CHECK (channel='CASH'),
    state text NOT NULL CHECK (state IN ('RESERVED','COMPLETED','RELEASED')),
    actor_id text NOT NULL, shift_id text NOT NULL, drawer_id text NOT NULL,
    recorded_at timestamptz NOT NULL, completed_at timestamptz, released_at timestamptz,
    confirmation_envelope jsonb,
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,stay_id,receipt_id) REFERENCES prsystem.guest_receipt (tenant_id,stay_id,id),
    FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    FOREIGN KEY (tenant_id,shift_id) REFERENCES prsystem.reception_shift,
    FOREIGN KEY (tenant_id,drawer_id) REFERENCES prsystem.cash_drawer,
    CHECK ((state='RESERVED' AND completed_at IS NULL AND released_at IS NULL AND confirmation_envelope IS NULL)
        OR (state='COMPLETED' AND completed_at IS NOT NULL AND released_at IS NULL AND confirmation_envelope IS NOT NULL)
        OR (state='RELEASED' AND released_at IS NOT NULL AND completed_at IS NULL AND confirmation_envelope IS NOT NULL))
);
CREATE INDEX guest_refund_pending ON prsystem.guest_refund (tenant_id,shift_id) WHERE state='RESERVED';
CREATE TABLE prsystem.guest_finance_event (
    tenant_id text NOT NULL, stay_id text NOT NULL, revision bigint NOT NULL,
    kind text NOT NULL, source_id text NOT NULL, actor_id text NOT NULL,
    details jsonb NOT NULL, recorded_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id,stay_id,revision),
    FOREIGN KEY (tenant_id,stay_id) REFERENCES prsystem.guest_finance,
    FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership (tenant_id,account_id)
);
CREATE FUNCTION prsystem.preserve_guest_finance_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE mutable text[];
BEGIN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable financial source' USING ERRCODE='23514'; END IF;
    mutable := CASE TG_TABLE_NAME WHEN 'guest_charge' THEN ARRAY['paid_mnt']
        WHEN 'guest_receipt' THEN ARRAY['allocated','refund_reserved','refunded','reversed']
        ELSE ARRAY['state','completed_at','released_at','confirmation_envelope'] END;
    IF to_jsonb(NEW)-mutable IS DISTINCT FROM to_jsonb(OLD)-mutable THEN
        RAISE EXCEPTION 'Immutable financial source' USING ERRCODE='23514'; END IF;
    IF TG_TABLE_NAME='guest_refund' THEN
        IF OLD.state<>'RESERVED' THEN RAISE EXCEPTION 'Terminal refund' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER guest_charge_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_charge
FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_guest_finance_source();
CREATE TRIGGER guest_receipt_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_receipt
FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_guest_finance_source();
CREATE TRIGGER guest_refund_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_refund
FOR EACH ROW EXECUTE FUNCTION prsystem.preserve_guest_finance_source();
CREATE TRIGGER guest_allocation_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_allocation
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TRIGGER guest_finance_event_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_finance_event
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();

ALTER TABLE prsystem.cash_event DROP CONSTRAINT cash_event_kind_check;
ALTER TABLE prsystem.cash_event DROP CONSTRAINT cash_event_check;
ALTER TABLE prsystem.cash_event ADD CHECK (kind IN ('TRANSFER_RESERVED','TRANSFER_OUT','TRANSFER_IN','TRANSFER_CANCELLED',
    'CASH_DEBIT','INITIAL_FLOAT','GUEST_DEPOSIT_RECEIVED','GUEST_PAYMENT_RECEIVED','GUEST_REFUND_RESERVED','GUEST_REFUND_PAID','GUEST_REFUND_RELEASED'));
ALTER TABLE prsystem.cash_event ADD CHECK (
    (kind IN ('TRANSFER_RESERVED','GUEST_REFUND_RESERVED') AND posted_delta=0 AND reserved_delta>0) OR
    (kind IN ('TRANSFER_OUT','GUEST_REFUND_PAID') AND posted_delta<0 AND reserved_delta=posted_delta) OR
    (kind IN ('TRANSFER_IN','INITIAL_FLOAT','GUEST_DEPOSIT_RECEIVED','GUEST_PAYMENT_RECEIVED') AND posted_delta>0 AND reserved_delta=0) OR
    (kind IN ('TRANSFER_CANCELLED','GUEST_REFUND_RELEASED') AND posted_delta=0 AND reserved_delta<0) OR
    (kind='CASH_DEBIT' AND posted_delta<0 AND reserved_delta=0));
REVOKE ALL ON prsystem.deposit_hotel_settings,prsystem.deposit_category_settings,prsystem.guest_finance,
prsystem.guest_charge,prsystem.guest_receipt,prsystem.guest_allocation,prsystem.guest_refund,prsystem.guest_finance_event FROM PUBLIC;
