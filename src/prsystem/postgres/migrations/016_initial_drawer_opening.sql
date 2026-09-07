CREATE TABLE prsystem.cash_location_config (
    tenant_id text NOT NULL, drawer_id text NOT NULL,
    code text NOT NULL CHECK (btrim(code)<>''), name text NOT NULL CHECK (btrim(name)<>''),
    physical_location text NOT NULL, expected_float bigint NOT NULL CHECK (expected_float>=0),
    status text NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
    revision bigint NOT NULL CHECK (revision>0), configured_by text NOT NULL,
    PRIMARY KEY (tenant_id,drawer_id), UNIQUE (tenant_id,code),
    FOREIGN KEY (tenant_id,drawer_id) REFERENCES prsystem.cash_drawer,
    FOREIGN KEY (tenant_id,configured_by) REFERENCES prsystem.staff_membership (tenant_id,account_id)
);
CREATE TABLE prsystem.cash_initial_opening (
    tenant_id text NOT NULL, drawer_id text NOT NULL, shift_id text NOT NULL,
    actor_id text NOT NULL, config_revision bigint NOT NULL,
    expected bigint NOT NULL CHECK (expected>=0), actual bigint NOT NULL CHECK (actual>=0),
    variance bigint NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    review_state text NOT NULL CHECK (review_state IN ('NOT_REQUIRED','ADMIN_REQUIRED','APPROVED','DISPUTED')),
    PRIMARY KEY (tenant_id,drawer_id), UNIQUE (tenant_id,shift_id),
    FOREIGN KEY (tenant_id,drawer_id) REFERENCES prsystem.cash_location_config,
    FOREIGN KEY (tenant_id,shift_id) REFERENCES prsystem.reception_shift (tenant_id,id),
    FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    CHECK (variance=actual-expected)
);
CREATE TRIGGER initial_opening_snapshot_immutable BEFORE UPDATE OF tenant_id,drawer_id,shift_id,
    actor_id,config_revision,expected,actual,variance,recorded_at ON prsystem.cash_initial_opening
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TRIGGER initial_opening_delete_forbidden BEFORE DELETE ON prsystem.cash_initial_opening
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();

-- INITIAL_FLOAT is location funding, never revenue; a zero opening has no
-- positive-money movement. The opening snapshot is still persisted for zero.
ALTER TABLE prsystem.cash_event DROP CONSTRAINT cash_event_kind_check;
ALTER TABLE prsystem.cash_event DROP CONSTRAINT cash_event_check;
ALTER TABLE prsystem.cash_event ADD CHECK (kind IN ('TRANSFER_RESERVED','TRANSFER_OUT',
    'TRANSFER_IN','TRANSFER_CANCELLED','CASH_DEBIT','INITIAL_FLOAT'));
ALTER TABLE prsystem.cash_event ADD CHECK (
    (kind='TRANSFER_RESERVED' AND posted_delta=0 AND reserved_delta>0) OR
    (kind='TRANSFER_OUT' AND posted_delta<0 AND reserved_delta=posted_delta) OR
    (kind='TRANSFER_IN' AND posted_delta>0 AND reserved_delta=0) OR
    (kind='TRANSFER_CANCELLED' AND posted_delta=0 AND reserved_delta<0) OR
    (kind='CASH_DEBIT' AND posted_delta<0 AND reserved_delta=0) OR
    (kind='INITIAL_FLOAT' AND posted_delta>0 AND reserved_delta=0));
CREATE UNIQUE INDEX one_initial_float ON prsystem.cash_event (tenant_id,drawer_id) WHERE kind='INITIAL_FLOAT';
REVOKE ALL ON prsystem.cash_location_config,prsystem.cash_initial_opening FROM PUBLIC;
