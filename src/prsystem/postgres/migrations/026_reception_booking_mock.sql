ALTER TABLE prsystem.stay DROP CONSTRAINT stay_origin_check;
ALTER TABLE prsystem.stay ADD CHECK(origin IN ('WALK_IN','ONLINE'));
ALTER TABLE prsystem.room_reservation DROP CONSTRAINT room_reservation_state_check;
ALTER TABLE prsystem.room_reservation ADD CHECK(state IN ('CONFIRMED','CANCELLED','CONSUMED'));
CREATE TABLE prsystem.reception_booking (
 tenant_id text NOT NULL,id text NOT NULL,room_id text NOT NULL,kind text NOT NULL,duration_units bigint NOT NULL,
 planned_checkin_at timestamptz NOT NULL,planned_checkout_at timestamptz NOT NULL,amount_mnt bigint NOT NULL CHECK(amount_mnt>0),
 snapshot jsonb NOT NULL,mode text NOT NULL CHECK(mode='MOCK_ONLY'),
 payment_reference text NOT NULL UNIQUE,confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,id),FOREIGN KEY(tenant_id,id) REFERENCES prsystem.room_reservation,
 FOREIGN KEY(tenant_id,room_id) REFERENCES prsystem.room
);
CREATE TABLE prsystem.booking_stay_application (
 tenant_id text NOT NULL,booking_id text NOT NULL,stay_id text NOT NULL,amount_mnt bigint NOT NULL CHECK(amount_mnt>0),
 PRIMARY KEY(tenant_id,booking_id),UNIQUE(tenant_id,stay_id),
 FOREIGN KEY(tenant_id,booking_id) REFERENCES prsystem.reception_booking,
 FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay
);
CREATE TRIGGER reception_booking_immutable BEFORE UPDATE OR DELETE ON prsystem.reception_booking FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TRIGGER booking_stay_immutable BEFORE UPDATE OR DELETE ON prsystem.booking_stay_application FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.reception_booking,prsystem.booking_stay_application FROM PUBLIC;
