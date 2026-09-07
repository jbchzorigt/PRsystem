-- Canonical account shared by staff realms; restaurant membership is separate.
CREATE TABLE prsystem.restaurant (
    id text PRIMARY KEY,
    created_by text NOT NULL REFERENCES prsystem.staff_account,
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    category text NOT NULL,
    description text NOT NULL,
    address text NOT NULL,
    latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    phone text NOT NULL,
    weekly_hours jsonb NOT NULL CHECK (jsonb_typeof(weekly_hours) = 'array'),
    timezone text NOT NULL DEFAULT 'Asia/Ulaanbaatar' CHECK (timezone = 'Asia/Ulaanbaatar'),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE prsystem.hotel_restaurant (
    tenant_id text NOT NULL REFERENCES prsystem.hotel_access,
    restaurant_id text NOT NULL REFERENCES prsystem.restaurant,
    created_by text NOT NULL,
    active boolean NOT NULL DEFAULT false,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    PRIMARY KEY (tenant_id, restaurant_id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES prsystem.staff_membership
);
CREATE TABLE prsystem.restaurant_membership (
    restaurant_id text NOT NULL REFERENCES prsystem.restaurant,
    account_id text NOT NULL REFERENCES prsystem.staff_account,
    status text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED')),
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    PRIMARY KEY (restaurant_id, account_id)
);
CREATE FUNCTION prsystem.restaurant_membership_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.restaurant_id, NEW.account_id) IS DISTINCT FROM ROW(OLD.restaurant_id, OLD.account_id) THEN
        RAISE EXCEPTION 'immutable restaurant membership identity';
    END IF;
    NEW.revision := OLD.revision + 1;
    RETURN NEW;
END; $$;
CREATE TRIGGER restaurant_membership_revision BEFORE UPDATE ON prsystem.restaurant_membership
FOR EACH ROW EXECUTE FUNCTION prsystem.restaurant_membership_revision();

ALTER TABLE prsystem.staff_session ALTER COLUMN tenant_id DROP NOT NULL;
ALTER TABLE prsystem.staff_session ADD COLUMN restaurant_id text;
ALTER TABLE prsystem.staff_session ADD CONSTRAINT session_restaurant_member
    FOREIGN KEY (restaurant_id, account_id) REFERENCES prsystem.restaurant_membership;
ALTER TABLE prsystem.staff_session ADD CONSTRAINT session_one_realm
    CHECK ((tenant_id IS NOT NULL) <> (restaurant_id IS NOT NULL));
ALTER TABLE prsystem.auth_event ADD COLUMN restaurant_id text REFERENCES prsystem.restaurant;
ALTER TABLE prsystem.auth_event ADD CONSTRAINT auth_event_one_scope
    CHECK (tenant_id IS NULL OR restaurant_id IS NULL);

ALTER TABLE prsystem.staff_link ADD COLUMN restaurant_id text;
ALTER TABLE prsystem.staff_link ADD COLUMN sponsor_tenant_id text;
ALTER TABLE prsystem.staff_link ADD CONSTRAINT link_restaurant_member
    FOREIGN KEY (restaurant_id, account_id) REFERENCES prsystem.restaurant_membership;
ALTER TABLE prsystem.staff_link ADD CONSTRAINT link_restaurant_sponsor
    FOREIGN KEY (sponsor_tenant_id, restaurant_id) REFERENCES prsystem.hotel_restaurant;
ALTER TABLE prsystem.staff_link ADD CONSTRAINT link_sponsor_inviter
    FOREIGN KEY (sponsor_tenant_id, inviter_id) REFERENCES prsystem.staff_membership;
-- Replace only the two purpose/scope CHECKs; preserve expiry/hash/state checks.
DO $$ DECLARE item record; BEGIN
    FOR item IN SELECT conname FROM pg_constraint WHERE conrelid = 'prsystem.staff_link'::regclass
        AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%purpose%'
    LOOP EXECUTE format('ALTER TABLE prsystem.staff_link DROP CONSTRAINT %I', item.conname); END LOOP;
END; $$;
ALTER TABLE prsystem.staff_link ADD CONSTRAINT staff_link_purpose_check CHECK (purpose IN ('INVITE', 'RESET', 'RESTAURANT_INVITE'));
ALTER TABLE prsystem.staff_link ADD CONSTRAINT staff_link_scope_check CHECK (
    (purpose = 'INVITE' AND tenant_id IS NOT NULL AND inviter_id IS NOT NULL AND membership_revision IS NOT NULL
        AND restaurant_id IS NULL AND sponsor_tenant_id IS NULL)
    OR (purpose = 'RESET' AND tenant_id IS NULL AND inviter_id IS NULL AND membership_revision IS NULL
        AND restaurant_id IS NULL AND sponsor_tenant_id IS NULL)
    OR (purpose = 'RESTAURANT_INVITE' AND tenant_id IS NULL AND inviter_id IS NOT NULL AND membership_revision IS NOT NULL
        AND restaurant_id IS NOT NULL AND sponsor_tenant_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_active_restaurant_invite ON prsystem.staff_link (restaurant_id, account_id)
    WHERE purpose = 'RESTAURANT_INVITE' AND state = 'ACTIVE';
CREATE TABLE prsystem.restaurant_staff_event (
    id text PRIMARY KEY,
    restaurant_id text NOT NULL REFERENCES prsystem.restaurant,
    sponsor_tenant_id text REFERENCES prsystem.hotel_access,
    actor_id text NOT NULL REFERENCES prsystem.staff_account,
    target_id text REFERENCES prsystem.staff_account,
    kind text NOT NULL CHECK (kind IN ('REGISTERED', 'LINKED', 'INVITED', 'RESENT', 'REVOKED', 'ACCEPTED',
        'SUSPENDED', 'TERMINATED', 'REACTIVATED', 'INVITE_RECOVERED')),
    details jsonb NOT NULL,
    recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE prsystem.staff_denied_event ADD COLUMN actor_restaurant_id text REFERENCES prsystem.restaurant;
ALTER TABLE prsystem.staff_denied_event ADD COLUMN requested_restaurant_id text REFERENCES prsystem.restaurant;
REVOKE ALL ON prsystem.restaurant, prsystem.hotel_restaurant, prsystem.restaurant_membership,
    prsystem.restaurant_staff_event FROM PUBLIC;
