CREATE TABLE prsystem.cash_book (
    tenant_id text PRIMARY KEY CHECK (btrim(tenant_id) <> ''),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);

CREATE TABLE prsystem.cash_drawer (
    tenant_id text NOT NULL REFERENCES prsystem.cash_book,
    id text NOT NULL CHECK (btrim(id) <> ''),
    shift_id text NOT NULL CHECK (btrim(shift_id) <> ''),
    posted bigint NOT NULL CHECK (posted >= 0),
    reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0 AND reserved <= posted),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, shift_id)
);

CREATE TABLE prsystem.cash_transfer (
    tenant_id text NOT NULL,
    id text NOT NULL CHECK (btrim(id) <> ''),
    source_id text NOT NULL,
    destination_id text NOT NULL,
    source_shift_id text NOT NULL,
    destination_shift_id text NOT NULL,
    amount bigint NOT NULL CHECK (amount > 0),
    state text NOT NULL CHECK (state IN ('PENDING', 'COMPLETED', 'CANCELLED')),
    PRIMARY KEY (tenant_id, id),
    FOREIGN KEY (tenant_id, source_id) REFERENCES prsystem.cash_drawer,
    FOREIGN KEY (tenant_id, destination_id) REFERENCES prsystem.cash_drawer,
    CHECK (source_id <> destination_id)
);
CREATE INDEX cash_pending ON prsystem.cash_transfer (tenant_id) WHERE state = 'PENDING';

CREATE TABLE prsystem.cash_event (
    tenant_id text NOT NULL,
    revision bigint NOT NULL CHECK (revision > 0),
    ordinal smallint NOT NULL CHECK (ordinal >= 0),
    kind text NOT NULL CHECK (kind IN
        ('TRANSFER_RESERVED', 'TRANSFER_OUT', 'TRANSFER_IN', 'TRANSFER_CANCELLED', 'CASH_DEBIT')),
    reference text NOT NULL CHECK (btrim(reference) <> ''),
    drawer_id text NOT NULL,
    shift_id text NOT NULL,
    posted_delta bigint NOT NULL,
    reserved_delta bigint NOT NULL,
    actor_id text NOT NULL CHECK (btrim(actor_id) <> ''),
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, revision, ordinal),
    FOREIGN KEY (tenant_id, drawer_id) REFERENCES prsystem.cash_drawer,
    UNIQUE (tenant_id, kind, reference),
    CHECK (
        (kind = 'TRANSFER_RESERVED' AND posted_delta = 0 AND reserved_delta > 0) OR
        (kind = 'TRANSFER_OUT' AND posted_delta < 0 AND reserved_delta = posted_delta) OR
        (kind = 'TRANSFER_IN' AND posted_delta > 0 AND reserved_delta = 0) OR
        (kind = 'TRANSFER_CANCELLED' AND posted_delta = 0 AND reserved_delta < 0) OR
        (kind = 'CASH_DEBIT' AND posted_delta < 0 AND reserved_delta = 0)
    )
);

CREATE TABLE prsystem.cash_receipt (
    tenant_id text NOT NULL REFERENCES prsystem.cash_book,
    key text NOT NULL CHECK (btrim(key) <> ''),
    actor_id text NOT NULL CHECK (btrim(actor_id) <> ''),
    command jsonb NOT NULL CHECK (jsonb_typeof(command) = 'object'),
    revision bigint NOT NULL CHECK (revision > 0),
    PRIMARY KEY (tenant_id, key)
);

-- Durable delivery intent only; dispatch/retry and external consumers are separate work.
CREATE TABLE prsystem.cash_outbox (
    tenant_id text NOT NULL REFERENCES prsystem.cash_book,
    revision bigint NOT NULL CHECK (revision > 0),
    topic text NOT NULL CHECK (topic = 'cash.changed'),
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    recorded_at timestamptz NOT NULL,
    PRIMARY KEY (tenant_id, revision)
);

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'cash_book', 'cash_drawer', 'cash_transfer', 'cash_event', 'cash_receipt', 'cash_outbox'
    ] LOOP
        EXECUTE format('ALTER TABLE prsystem.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE prsystem.%I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_scope ON prsystem.%I USING '
            '(tenant_id = nullif(current_setting(''prsystem.tenant_id'', true), '''')) '
            'WITH CHECK (tenant_id = nullif(current_setting(''prsystem.tenant_id'', true), ''''))',
            table_name
        );
    END LOOP;
END; $$;
