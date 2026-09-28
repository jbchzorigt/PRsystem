-- These rows contain only the approved public profile. Tenant mutation remains
-- authorized in the service. Operational inventory keeps FORCE RLS.
CREATE TABLE prsystem.booking_listing(tenant_id text PRIMARY KEY REFERENCES prsystem.hotel_access,name text NOT NULL,address text NOT NULL,phone text NOT NULL,description text NOT NULL,latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),photos jsonb NOT NULL,published boolean NOT NULL,accepting boolean NOT NULL,revision bigint NOT NULL,actor_id text NOT NULL,FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership(tenant_id,account_id));
CREATE TABLE prsystem.booking_publication(tenant_id text PRIMARY KEY REFERENCES prsystem.hotel_access,allowed boolean NOT NULL,revision bigint NOT NULL,actor_id text NOT NULL REFERENCES prsystem.platform_account);
CREATE TABLE prsystem.booking_category_listing(tenant_id text NOT NULL,category_id text NOT NULL,photos jsonb NOT NULL,published boolean NOT NULL,revision bigint NOT NULL,PRIMARY KEY(tenant_id,category_id),FOREIGN KEY(tenant_id,category_id) REFERENCES prsystem.room_category(tenant_id,id));
ALTER TABLE prsystem.booking_category_listing ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.booking_category_listing FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON prsystem.booking_category_listing USING(tenant_id=current_setting('prsystem.tenant_id',true)) WITH CHECK(tenant_id=current_setting('prsystem.tenant_id',true));
REVOKE ALL ON prsystem.booking_listing,prsystem.booking_publication,prsystem.booking_category_listing FROM PUBLIC;
