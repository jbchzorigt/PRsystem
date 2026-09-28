-- Operational request snapshots. Only trusted room/config adapters insert these;
-- there is no client API accepting authority snapshots or stock opening balances.
CREATE TABLE prsystem.cleaning_source (
    tenant_id text NOT NULL REFERENCES prsystem.hotel_access,
    id text NOT NULL,
    room_id text NOT NULL,
    configuration_id text NOT NULL,
    configuration_version bigint NOT NULL CHECK (configuration_version >= 0),
    source_kind text NOT NULL CHECK (source_kind IN ('CHECKOUT', 'CONFIGURATION', 'REFILL')),
    source_reference text NOT NULL,
    snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, source_kind, source_reference)
);
CREATE TABLE prsystem.cleaning_task (
    tenant_id text NOT NULL,
    id text NOT NULL,
    source_id text NOT NULL,
    parent_id text,
    assignee_id text NOT NULL,
    assignment_version bigint NOT NULL DEFAULT 0 CHECK (assignment_version >= 0),
    state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'CONTINUED', 'DONE')),
    started_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, id, source_id),
    UNIQUE (tenant_id, parent_id),
    FOREIGN KEY (tenant_id, source_id) REFERENCES prsystem.cleaning_source,
    FOREIGN KEY (tenant_id, parent_id, source_id) REFERENCES prsystem.cleaning_task (tenant_id, id, source_id),
    FOREIGN KEY (tenant_id, assignee_id) REFERENCES prsystem.staff_membership (tenant_id, account_id)
);
CREATE UNIQUE INDEX cleaning_one_open_source ON prsystem.cleaning_task (tenant_id, source_id) WHERE state = 'OPEN';
CREATE TABLE prsystem.cleaning_action (
    tenant_id text NOT NULL,
    source_id text NOT NULL,
    id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('CLEAN', 'COUNT', 'REFILL', 'RETURN')),
    product_id text,
    quantity bigint NOT NULL CHECK (quantity > 0),
    completed bigint NOT NULL DEFAULT 0 CHECK (completed >= 0 AND completed <= quantity),
    PRIMARY KEY (tenant_id, source_id, id),
    FOREIGN KEY (tenant_id, source_id) REFERENCES prsystem.cleaning_source,
    CHECK ((kind = 'CLEAN' AND product_id IS NULL AND quantity = 1)
        OR (kind = 'COUNT' AND product_id IS NOT NULL AND quantity = 1)
        OR (kind IN ('REFILL', 'RETURN') AND product_id IS NOT NULL))
);
CREATE TABLE prsystem.cleaning_stock (
    tenant_id text NOT NULL REFERENCES prsystem.hotel_access,
    product_id text NOT NULL,
    location_id text NOT NULL,
    quantity bigint NOT NULL CHECK (quantity >= 0),
    PRIMARY KEY (tenant_id, product_id, location_id)
);
CREATE TABLE prsystem.cleaning_posting (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    task_id text NOT NULL,
    source_id text NOT NULL,
    action_id text NOT NULL,
    assignment_version bigint NOT NULL,
    actor_id text NOT NULL,
    quantity bigint NOT NULL CHECK (quantity > 0),
    actual_count bigint CHECK (actual_count >= 0),
    from_location text,
    to_location text,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, task_id, source_id) REFERENCES prsystem.cleaning_task (tenant_id, id, source_id),
    FOREIGN KEY (tenant_id, source_id, action_id) REFERENCES prsystem.cleaning_action,
    FOREIGN KEY (tenant_id, actor_id) REFERENCES prsystem.staff_membership (tenant_id, account_id)
);
CREATE TABLE prsystem.operational_event (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    kind text NOT NULL,
    source_id text NOT NULL,
    details jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, actor_id) REFERENCES prsystem.staff_membership (tenant_id, account_id)
);
CREATE FUNCTION prsystem.reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Immutable operational history' USING ERRCODE = '23514'; END;
$$;
CREATE TRIGGER cleaning_source_immutable BEFORE UPDATE OR DELETE ON prsystem.cleaning_source
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TRIGGER cleaning_posting_immutable BEFORE UPDATE OR DELETE ON prsystem.cleaning_posting
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TRIGGER operational_event_immutable BEFORE UPDATE OR DELETE ON prsystem.operational_event
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.cleaning_source, prsystem.cleaning_task, prsystem.cleaning_action,
    prsystem.cleaning_stock, prsystem.cleaning_posting, prsystem.operational_event FROM PUBLIC;
