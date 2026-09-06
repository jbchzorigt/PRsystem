-- Staff realm only. No Guest, Restaurant, Operation or Police identity grant.
CREATE TABLE prsystem.staff_account (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email = lower(btrim(email)) AND length(email) <= 254),
    password_hash text NOT NULL,
    verified_at timestamptz,
    status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
    auth_epoch bigint NOT NULL DEFAULT 0 CHECK (auth_epoch >= 0)
);
CREATE TABLE prsystem.hotel_access (
    tenant_id text PRIMARY KEY,
    package_mnt integer NOT NULL CHECK (package_mnt IN (20000, 25000, 30000)),
    expires_at timestamptz NOT NULL,
    security_suspended boolean NOT NULL DEFAULT false
);
CREATE TABLE prsystem.staff_membership (
    tenant_id text NOT NULL REFERENCES prsystem.hotel_access,
    account_id text NOT NULL REFERENCES prsystem.staff_account,
    status text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED')),
    roles text[] NOT NULL CHECK (cardinality(roles) > 0 AND array_position(roles, NULL) IS NULL AND
        roles <@ ARRAY['HOTEL_ADMIN', 'MANAGER', 'MANAGER_PLUS', 'RECEPTION', 'CLEANER']::text[]),
    is_primary boolean NOT NULL DEFAULT false,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    PRIMARY KEY (tenant_id, account_id),
    CHECK (is_primary = ('HOTEL_ADMIN' = ANY(roles)))
);
CREATE UNIQUE INDEX one_primary_hotel_admin ON prsystem.staff_membership (tenant_id) WHERE is_primary;

CREATE TABLE prsystem.staff_session (
    token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
    tenant_id text NOT NULL,
    account_id text NOT NULL,
    auth_epoch bigint NOT NULL,
    membership_revision bigint NOT NULL,
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL,
    revoked_at timestamptz,
    FOREIGN KEY (tenant_id, account_id) REFERENCES prsystem.staff_membership,
    CHECK (expires_at > created_at AND last_seen_at >= created_at)
);
CREATE INDEX staff_session_account ON prsystem.staff_session (account_id);
CREATE TABLE prsystem.auth_rate_bucket (
    key text PRIMARY KEY CHECK (length(key) = 64),
    window_started timestamptz NOT NULL,
    attempts bigint NOT NULL CHECK (attempts > 0)
);
CREATE TABLE prsystem.auth_event (
    id text PRIMARY KEY,
    kind text NOT NULL CHECK (kind IN ('LOGIN', 'LOGOUT', 'LOGOUT_ALL', 'PASSWORD_CHANGED', 'CASH_READ_DENIED')),
    actor_id text NOT NULL REFERENCES prsystem.staff_account,
    tenant_id text REFERENCES prsystem.hotel_access,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- A security change cannot restore an old session, including after reactivation.
CREATE FUNCTION prsystem.staff_account_epoch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id <> OLD.id OR NEW.auth_epoch < OLD.auth_epoch THEN
        RAISE EXCEPTION 'immutable account identity/epoch';
    END IF;
    IF ROW(NEW.password_hash, NEW.status, NEW.verified_at) IS DISTINCT FROM
       ROW(OLD.password_hash, OLD.status, OLD.verified_at) THEN
        NEW.auth_epoch := OLD.auth_epoch + 1;
    END IF;
    RETURN NEW;
END; $$;
CREATE TRIGGER staff_account_epoch BEFORE UPDATE ON prsystem.staff_account
FOR EACH ROW EXECUTE FUNCTION prsystem.staff_account_epoch();

CREATE FUNCTION prsystem.staff_membership_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.tenant_id, NEW.account_id) IS DISTINCT FROM ROW(OLD.tenant_id, OLD.account_id) THEN
        RAISE EXCEPTION 'immutable membership identity';
    END IF;
    NEW.revision := OLD.revision + 1;
    RETURN NEW;
END; $$;
CREATE TRIGGER staff_membership_revision BEFORE UPDATE ON prsystem.staff_membership
FOR EACH ROW EXECUTE FUNCTION prsystem.staff_membership_revision();

-- Private identity tables are accessed only by trusted server queries. Unlike
-- business tables, they must resolve credentials before tenant scope is known.
REVOKE ALL ON prsystem.staff_account, prsystem.hotel_access, prsystem.staff_membership,
    prsystem.staff_session, prsystem.auth_rate_bucket, prsystem.auth_event FROM PUBLIC;
