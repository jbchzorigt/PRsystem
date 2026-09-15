-- Separate realm; never joined to hotel staff memberships to infer authority.
CREATE TABLE prsystem.platform_account (
    id text PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email=lower(btrim(email))),
    password_hash text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    permissions text[] NOT NULL DEFAULT '{}',
    mfa_key_ref text NOT NULL,
    last_totp_counter bigint NOT NULL DEFAULT -1,
    revision bigint NOT NULL DEFAULT 0
);
CREATE TABLE prsystem.platform_session (
    token_hash text PRIMARY KEY CHECK (length(token_hash)=64),
    account_id text NOT NULL REFERENCES prsystem.platform_account,
    revision bigint NOT NULL,
    mfa_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);
CREATE TABLE prsystem.platform_event (
    id text PRIMARY KEY,
    actor_id text REFERENCES prsystem.platform_account,
    action text NOT NULL,
    target_id text,
    details jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER platform_event_immutable BEFORE UPDATE OR DELETE ON prsystem.platform_event
FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.platform_receipt (
    key text PRIMARY KEY,
    actor_id text NOT NULL REFERENCES prsystem.platform_account,
    command jsonb NOT NULL,
    result jsonb NOT NULL
);
CREATE FUNCTION prsystem.platform_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id<>OLD.id THEN RAISE EXCEPTION 'Immutable platform identity'; END IF;
    IF ROW(NEW.email,NEW.password_hash,NEW.active,NEW.permissions,NEW.mfa_key_ref)
        IS DISTINCT FROM ROW(OLD.email,OLD.password_hash,OLD.active,OLD.permissions,OLD.mfa_key_ref) THEN
        NEW.revision:=OLD.revision+1;
    ELSIF NEW.revision<OLD.revision OR NEW.last_totp_counter<OLD.last_totp_counter THEN
        RAISE EXCEPTION 'Monotonic platform security state';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER platform_revision BEFORE UPDATE ON prsystem.platform_account
FOR EACH ROW EXECUTE FUNCTION prsystem.platform_revision();
REVOKE ALL ON prsystem.platform_account,prsystem.platform_session,prsystem.platform_event,prsystem.platform_receipt FROM PUBLIC;
