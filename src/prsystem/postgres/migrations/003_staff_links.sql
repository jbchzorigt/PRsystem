ALTER TABLE prsystem.staff_account ADD COLUMN display_name text NOT NULL DEFAULT '';

CREATE TABLE prsystem.staff_link (
    id text PRIMARY KEY,
    purpose text NOT NULL CHECK (purpose IN ('INVITE', 'RESET')),
    account_id text NOT NULL REFERENCES prsystem.staff_account,
    tenant_id text REFERENCES prsystem.hotel_access,
    inviter_id text REFERENCES prsystem.staff_account,
    membership_revision bigint,
    issued_epoch bigint NOT NULL,
    token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
    state text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'ACCEPTED', 'SUPERSEDED', 'EXPIRED', 'REVOKED')),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, account_id) REFERENCES prsystem.staff_membership,
    FOREIGN KEY (tenant_id, inviter_id) REFERENCES prsystem.staff_membership,
    CHECK (expires_at > created_at),
    CHECK ((purpose = 'INVITE' AND tenant_id IS NOT NULL AND inviter_id IS NOT NULL AND membership_revision IS NOT NULL)
        OR (purpose = 'RESET' AND tenant_id IS NULL AND inviter_id IS NULL AND membership_revision IS NULL))
);
CREATE UNIQUE INDEX one_active_invite ON prsystem.staff_link (tenant_id, account_id)
    WHERE purpose = 'INVITE' AND state = 'ACTIVE';
CREATE UNIQUE INDEX one_active_reset ON prsystem.staff_link (account_id)
    WHERE purpose = 'RESET' AND state = 'ACTIVE';

-- Contains identifiers only. The internal dispatcher derives the token using a
-- deployment secret, so no plaintext link secret is persisted for email retry.
CREATE TABLE prsystem.staff_mail_intent (
    link_id text PRIMARY KEY REFERENCES prsystem.staff_link,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    delivered_at timestamptz
);
CREATE TABLE prsystem.password_reset_request (
    id text PRIMARY KEY,
    email text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    processed_at timestamptz
);
CREATE INDEX reset_request_email ON prsystem.password_reset_request (email, created_at, id);
CREATE INDEX reset_request_pending ON prsystem.password_reset_request (created_at) WHERE processed_at IS NULL;

CREATE TABLE prsystem.staff_command_receipt (
    tenant_id text NOT NULL REFERENCES prsystem.hotel_access,
    key text NOT NULL,
    actor_id text NOT NULL REFERENCES prsystem.staff_account,
    command jsonb NOT NULL,
    result jsonb NOT NULL,
    PRIMARY KEY (tenant_id, key),
    FOREIGN KEY (tenant_id, actor_id) REFERENCES prsystem.staff_membership
);
CREATE TABLE prsystem.staff_lifecycle_event (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('INVITE_CREATED', 'INVITE_RESENT', 'INVITE_REVOKED',
        'INVITE_ACCEPTED', 'RESET_REQUESTED', 'PASSWORD_RESET')),
    actor_id text REFERENCES prsystem.staff_account,
    target_id text NOT NULL REFERENCES prsystem.staff_account,
    tenant_id text REFERENCES prsystem.hotel_access,
    link_id text REFERENCES prsystem.staff_link,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    FOREIGN KEY (tenant_id, target_id) REFERENCES prsystem.staff_membership
);
REVOKE ALL ON prsystem.staff_link, prsystem.staff_mail_intent, prsystem.password_reset_request,
    prsystem.staff_command_receipt, prsystem.staff_lifecycle_event FROM PUBLIC;
