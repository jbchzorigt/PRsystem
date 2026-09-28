ALTER TABLE prsystem.room DROP CONSTRAINT room_minibar_mode_check;
ALTER TABLE prsystem.room ADD CHECK(minibar_mode IN ('OFF','MOCK_ON'));
ALTER TABLE prsystem.guest_charge DROP CONSTRAINT guest_charge_kind_check;
ALTER TABLE prsystem.guest_charge ADD CHECK(kind IN ('ROOM','MINIBAR'));
CREATE TABLE prsystem.mock_minibar_configuration (
 tenant_id text NOT NULL,room_id text NOT NULL,revision bigint NOT NULL,items jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,room_id,revision),
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room
);
CREATE TRIGGER minibar_configuration_immutable BEFORE UPDATE OR DELETE ON prsystem.mock_minibar_configuration FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.reception_checkout_intent (
 tenant_id text NOT NULL,stay_id text NOT NULL,actor_id text NOT NULL,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,stay_id),FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay
);
CREATE TRIGGER checkout_intent_immutable BEFORE UPDATE OR DELETE ON prsystem.reception_checkout_intent FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.reception_minibar_inspection (
 tenant_id text NOT NULL,stay_id text NOT NULL,state text NOT NULL DEFAULT 'REQUESTED' CHECK(state IN ('REQUESTED','REPORTED','DISPUTED')),
 revision bigint NOT NULL DEFAULT 0,PRIMARY KEY(tenant_id,stay_id),FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay
);
CREATE TABLE prsystem.reception_minibar_report (
 tenant_id text NOT NULL,stay_id text NOT NULL,revision bigint NOT NULL,actor_id text NOT NULL,items jsonb NOT NULL,
 amount_mnt bigint NOT NULL CHECK(amount_mnt>=0),charge_id text,reason text,recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,stay_id,revision),FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay,
 FOREIGN KEY(tenant_id,charge_id) REFERENCES prsystem.guest_charge
);
CREATE TRIGGER minibar_report_immutable BEFORE UPDATE OR DELETE ON prsystem.reception_minibar_report FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.guest_charge_adjustment (
 tenant_id text NOT NULL,charge_id text NOT NULL,id text NOT NULL,amount_mnt bigint NOT NULL CHECK(amount_mnt<0),reason text NOT NULL,actor_id text NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,charge_id),
 FOREIGN KEY(tenant_id,charge_id) REFERENCES prsystem.guest_charge
);
CREATE TRIGGER charge_adjustment_immutable BEFORE UPDATE OR DELETE ON prsystem.guest_charge_adjustment FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TABLE prsystem.reception_restaurant_order (
 tenant_id text NOT NULL,stay_id text NOT NULL,id text NOT NULL,restaurant_name text NOT NULL,contact_phone text NOT NULL,
 state text NOT NULL CHECK(state IN ('PAID_PENDING','ACCEPTED','PREPARING','READY','DONE','REFUNDED')),
 mode text NOT NULL CHECK(mode='MOCK_ONLY'),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay
);
CREATE TABLE prsystem.restaurant_checkout_outbox (
 tenant_id text NOT NULL,order_id text NOT NULL,stay_id text NOT NULL,choice text NOT NULL CHECK(choice IN ('RECEPTION_PICKUP','GUEST_PICKUP','REFUND_REQUEST')),
 actor_id text NOT NULL,guest_informed boolean NOT NULL CHECK(guest_informed),recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,order_id),FOREIGN KEY(tenant_id,order_id) REFERENCES prsystem.reception_restaurant_order
);
CREATE TRIGGER restaurant_checkout_immutable BEFORE UPDATE OR DELETE ON prsystem.restaurant_checkout_outbox FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.mock_minibar_configuration,prsystem.reception_checkout_intent,prsystem.reception_minibar_inspection,
prsystem.reception_minibar_report,prsystem.guest_charge_adjustment,prsystem.reception_restaurant_order,prsystem.restaurant_checkout_outbox FROM PUBLIC;
