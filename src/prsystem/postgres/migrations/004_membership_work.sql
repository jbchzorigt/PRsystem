-- Private staff tables: explicit tenant predicates, no PUBLIC/runtime grants.
-- Source adapters must register work in their own opening transaction. This
-- registry is not an operational shift, cleaning task or cash handover ledger.
CREATE TABLE prsystem.staff_open_work (
    tenant_id text NOT NULL,
    id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('SHIFT', 'CLEANING_TASK')),
    source_id text NOT NULL,
    owner_id text NOT NULL,
    assignment_version bigint NOT NULL DEFAULT 0 CHECK (assignment_version >= 0),
    state text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN', 'BLOCKED', 'CLOSED')),
    shift_id text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, kind, source_id),
    FOREIGN KEY (tenant_id, owner_id) REFERENCES prsystem.staff_membership (tenant_id, account_id),
    FOREIGN KEY (tenant_id, shift_id) REFERENCES prsystem.cash_drawer (tenant_id, shift_id),
    CHECK ((kind = 'SHIFT' AND shift_id IS NOT NULL AND shift_id = source_id)
        OR (kind = 'CLEANING_TASK' AND shift_id IS NULL))
);
CREATE INDEX staff_work_owner ON prsystem.staff_open_work (tenant_id, owner_id) WHERE state = 'OPEN';

CREATE TABLE prsystem.staff_work_exception (
    tenant_id text NOT NULL,
    id text NOT NULL,
    work_id text NOT NULL,
    reason text NOT NULL CHECK (reason IN ('TAKEOVER_REQUIRED', 'REASSIGNMENT_REQUIRED')),
    claimant_id text,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (tenant_id, id),
    UNIQUE (tenant_id, work_id),
    FOREIGN KEY (tenant_id, work_id) REFERENCES prsystem.staff_open_work,
    FOREIGN KEY (tenant_id, claimant_id) REFERENCES prsystem.staff_membership (tenant_id, account_id)
);
CREATE INDEX staff_exception_claimant ON prsystem.staff_work_exception (tenant_id, claimant_id);

CREATE TABLE prsystem.staff_change_event (
    id text PRIMARY KEY,
    tenant_id text NOT NULL,
    actor_id text NOT NULL,
    target_id text NOT NULL,
    kind text NOT NULL CHECK (kind IN ('MEMBERSHIP_CHANGED', 'WORK_CLAIMED', 'WORK_CLAIM_RELEASED')),
    details jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, actor_id) REFERENCES prsystem.staff_membership (tenant_id, account_id),
    FOREIGN KEY (tenant_id, target_id) REFERENCES prsystem.staff_membership (tenant_id, account_id)
);
REVOKE ALL ON prsystem.staff_open_work, prsystem.staff_work_exception, prsystem.staff_change_event FROM PUBLIC;
