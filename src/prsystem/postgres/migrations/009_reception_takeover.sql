-- Historical shift identities must survive the drawer's next current shift.
CREATE TABLE prsystem.cash_shift_reference (
    tenant_id text NOT NULL,
    shift_id text NOT NULL,
    drawer_id text NOT NULL,
    PRIMARY KEY (tenant_id,shift_id),
    FOREIGN KEY (tenant_id,drawer_id) REFERENCES prsystem.cash_drawer
);
INSERT INTO prsystem.cash_shift_reference SELECT tenant_id,shift_id,id FROM prsystem.cash_drawer;
ALTER TABLE prsystem.staff_open_work DROP CONSTRAINT staff_open_work_tenant_id_shift_id_fkey;
ALTER TABLE prsystem.staff_open_work ADD FOREIGN KEY (tenant_id,shift_id)
    REFERENCES prsystem.cash_shift_reference (tenant_id,shift_id);
CREATE FUNCTION prsystem.remember_cash_shift() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO prsystem.cash_shift_reference (tenant_id,shift_id,drawer_id)
    VALUES (NEW.tenant_id,NEW.shift_id,NEW.id) ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$;
CREATE TRIGGER cash_shift_identity AFTER INSERT OR UPDATE OF shift_id ON prsystem.cash_drawer
FOR EACH ROW EXECUTE FUNCTION prsystem.remember_cash_shift();
CREATE TABLE prsystem.reception_shift (
    tenant_id text NOT NULL,
    id text NOT NULL,
    owner_id text NOT NULL,
    drawer_id text NOT NULL,
    opening_actual bigint NOT NULL CHECK (opening_actual>=0),
    state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','CLOSED')),
    opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    closed_at timestamptz,
    review_state text NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK (review_state IN ('NOT_SUBMITTED','MANAGER_REQUIRED','ADMIN_REQUIRED','APPROVED','DISPUTED')),
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,id) REFERENCES prsystem.cash_shift_reference (tenant_id,shift_id),
    FOREIGN KEY (tenant_id,owner_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    FOREIGN KEY (tenant_id,drawer_id) REFERENCES prsystem.cash_drawer
);
CREATE UNIQUE INDEX one_open_reception_drawer ON prsystem.reception_shift (tenant_id,drawer_id) WHERE state='OPEN';
CREATE UNIQUE INDEX one_open_reception_owner ON prsystem.reception_shift (tenant_id,owner_id) WHERE state='OPEN';
CREATE TABLE prsystem.shift_takeover (
    tenant_id text NOT NULL,
    id text NOT NULL,
    exception_id text NOT NULL,
    shift_id text NOT NULL,
    replacement_id text NOT NULL,
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz,
    new_shift_id text,
    PRIMARY KEY (tenant_id,id),
    UNIQUE (tenant_id,exception_id),
    FOREIGN KEY (tenant_id,exception_id) REFERENCES prsystem.staff_work_exception,
    FOREIGN KEY (tenant_id,shift_id) REFERENCES prsystem.reception_shift,
    FOREIGN KEY (tenant_id,replacement_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    FOREIGN KEY (tenant_id,created_by) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    FOREIGN KEY (tenant_id,new_shift_id) REFERENCES prsystem.reception_shift
);
CREATE TABLE prsystem.shift_obligation (
    tenant_id text NOT NULL,
    id text NOT NULL,
    shift_id text NOT NULL,
    provider_reference text NOT NULL,
    state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING','SUCCEEDED','FAILED','EXPIRED')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,id),
    UNIQUE (tenant_id,provider_reference),
    FOREIGN KEY (tenant_id,shift_id) REFERENCES prsystem.reception_shift
);
CREATE TABLE prsystem.shift_reconcile_intent (
    tenant_id text NOT NULL,
    obligation_id text NOT NULL,
    takeover_id text NOT NULL,
    requested_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,obligation_id,takeover_id),
    FOREIGN KEY (tenant_id,obligation_id) REFERENCES prsystem.shift_obligation,
    FOREIGN KEY (tenant_id,takeover_id) REFERENCES prsystem.shift_takeover,
    FOREIGN KEY (tenant_id,requested_by) REFERENCES prsystem.staff_membership (tenant_id,account_id)
);
CREATE TABLE prsystem.shift_cash_count (
    tenant_id text NOT NULL,
    id text NOT NULL,
    takeover_id text NOT NULL,
    actor_id text NOT NULL,
    book_revision bigint NOT NULL,
    expected bigint NOT NULL CHECK (expected>=0),
    actual bigint NOT NULL CHECK (actual>=0),
    variance bigint NOT NULL,
    counted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,takeover_id) REFERENCES prsystem.shift_takeover,
    FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    CHECK (variance=actual-expected)
);
CREATE TRIGGER shift_count_immutable BEFORE UPDATE OR DELETE ON prsystem.shift_cash_count
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.transfer_cancel_request (
    tenant_id text NOT NULL,
    transfer_id text NOT NULL,
    actor_id text NOT NULL,
    reason text NOT NULL CHECK (btrim(reason)<>''),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id,transfer_id),
    FOREIGN KEY (tenant_id,transfer_id) REFERENCES prsystem.cash_transfer,
    FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership (tenant_id,account_id)
);
CREATE TRIGGER transfer_cancel_immutable BEFORE UPDATE OR DELETE ON prsystem.transfer_cancel_request
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.cash_shift_reference,prsystem.reception_shift,prsystem.shift_takeover,
    prsystem.shift_obligation,prsystem.shift_reconcile_intent,prsystem.shift_cash_count,
    prsystem.transfer_cancel_request FROM PUBLIC;
