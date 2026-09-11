CREATE TABLE prsystem.room_hotel_settings (
    tenant_id text PRIMARY KEY REFERENCES prsystem.hotel_access,
    hourly_price bigint NOT NULL CHECK (hourly_price>0),
    nightly_price bigint NOT NULL CHECK (nightly_price>0),
    checkout_time time NOT NULL,
    revision bigint NOT NULL CHECK (revision>0)
);
CREATE TABLE prsystem.room_category (
    tenant_id text NOT NULL REFERENCES prsystem.hotel_access,
    id text NOT NULL, name text NOT NULL CHECK (btrim(name)<>''), description text NOT NULL,
    hourly_price bigint CHECK (hourly_price>0), nightly_price bigint CHECK (nightly_price>0),
    deposit bigint NOT NULL CHECK (deposit>=0), cleaning_buffer_minutes integer NOT NULL CHECK (cleaning_buffer_minutes>=0),
    status text NOT NULL CHECK (status IN ('ACTIVE','RETIRING','INACTIVE')),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    PRIMARY KEY (tenant_id,id)
);
CREATE UNIQUE INDEX room_category_name ON prsystem.room_category (tenant_id,lower(name));
CREATE TABLE prsystem.room (
    tenant_id text NOT NULL, id text NOT NULL, number text NOT NULL CHECK (btrim(number)<>''),
    floor text NOT NULL, category_id text NOT NULL,
    hourly_price bigint CHECK (hourly_price>0), nightly_price bigint CHECK (nightly_price>0),
    status text NOT NULL CHECK (status IN ('ACTIVE','RETIRING','INACTIVE')),
    cleaning_state text NOT NULL DEFAULT 'DIRTY' CHECK (cleaning_state IN ('DIRTY','CLEANING','CLEAN')),
    minibar_mode text NOT NULL DEFAULT 'OFF' CHECK (minibar_mode='OFF'),
    revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
    PRIMARY KEY (tenant_id,id),
    FOREIGN KEY (tenant_id,category_id) REFERENCES prsystem.room_category
);
CREATE UNIQUE INDEX room_number ON prsystem.room (tenant_id,lower(number));
-- Mode ON needs the canonical exact published template/stock producer. The
-- catalog never represents an unconfigured minibar as ready.
REVOKE ALL ON prsystem.room_hotel_settings,prsystem.room_category,prsystem.room FROM PUBLIC;
