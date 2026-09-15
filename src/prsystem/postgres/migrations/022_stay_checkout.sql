CREATE TABLE prsystem.stay_checkout (
    tenant_id text NOT NULL, stay_id text NOT NULL, actor_id text NOT NULL, shift_id text NOT NULL,
    room_id text NOT NULL, recorded_at timestamptz NOT NULL,
    finance_revision bigint NOT NULL CHECK (finance_revision>0), financial_snapshot jsonb NOT NULL,
    cleaning_source_id text,
    retention_policy_version text NOT NULL, retention_days integer NOT NULL CHECK (retention_days>0),
    retention_expires_at timestamptz NOT NULL CHECK (retention_expires_at>recorded_at),
    PRIMARY KEY (tenant_id,stay_id),
    FOREIGN KEY (tenant_id,stay_id) REFERENCES prsystem.stay,
    FOREIGN KEY (tenant_id,stay_id,finance_revision) REFERENCES prsystem.guest_finance_event (tenant_id,stay_id,revision),
    FOREIGN KEY (tenant_id,actor_id) REFERENCES prsystem.staff_membership (tenant_id,account_id),
    FOREIGN KEY (tenant_id,shift_id) REFERENCES prsystem.reception_shift,
    FOREIGN KEY (tenant_id,room_id) REFERENCES prsystem.room,
    FOREIGN KEY (tenant_id,cleaning_source_id) REFERENCES prsystem.cleaning_source
);
CREATE TRIGGER stay_checkout_immutable BEFORE UPDATE OR DELETE ON prsystem.stay_checkout
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.stay_checkout FROM PUBLIC;
