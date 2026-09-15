-- Restaurant money remains outside guest charges, hotel cash and settlement.
CREATE TABLE prsystem.restaurant_menu_item (
 restaurant_id text NOT NULL REFERENCES prsystem.restaurant, id text NOT NULL,
 category text NOT NULL, name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
 description text NOT NULL CHECK(length(description)<=2000),
 price_mnt bigint NOT NULL CHECK(price_mnt>0), active boolean NOT NULL, available boolean NOT NULL,
 revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),
 PRIMARY KEY(restaurant_id,id)
);
CREATE TABLE prsystem.restaurant_schedule_exception (
 restaurant_id text NOT NULL REFERENCES prsystem.restaurant, closed_date date NOT NULL,
 PRIMARY KEY(restaurant_id,closed_date)
);
CREATE TABLE prsystem.restaurant_order_record (
 tenant_id text NOT NULL, id text NOT NULL, restaurant_id text NOT NULL, stay_id text NOT NULL,
 merchant_id text NOT NULL CHECK(length(btrim(merchant_id))>0),
 amount_mnt bigint NOT NULL CHECK(amount_mnt>0), items jsonb NOT NULL CHECK(jsonb_typeof(items)='array' AND jsonb_array_length(items)>0),
 contact_phone_snapshot text NOT NULL, restaurant_name_snapshot text NOT NULL, room_number_snapshot text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL,
 invoice_id text, state jsonb, revision bigint NOT NULL DEFAULT 0,
 PRIMARY KEY(tenant_id,id), UNIQUE(restaurant_id,id),
 FOREIGN KEY(tenant_id,restaurant_id) REFERENCES prsystem.hotel_restaurant,
 FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay,
 CHECK(expires_at>created_at), CHECK(revision>=0),
 CHECK((invoice_id IS NULL)=(state IS NULL)),
 CHECK(state IS NULL OR (jsonb_typeof(state)='object'
  AND state->>'order' IN ('PENDING_PAYMENT','CONFIRMED','CANCELLED','COMPLETED')
  AND state->>'fulfillment' IN ('NOT_STARTED','AWAITING_ACCEPTANCE','ACCEPTED','PREPARING','READY','OUT_FOR_DELIVERY','DELIVERED_TO_ROOM','HANDED_TO_RECEPTION','PICKED_UP_BY_GUEST','CANCELLED')
  AND state->>'payment' IN ('PENDING','PAID','FAILED','EXPIRED')
  AND state->>'refund_policy' IN ('NONE','MANDATORY','DISCRETIONARY')
  AND state->>'refund_request' IN ('NONE','OPEN','APPROVED','REJECTED','RESOLVED')
  AND state->>'refund' IN ('NONE','PENDING','REFUNDED','FAILED')
  AND state->>'handoff' IN ('ROOM','RECEPTION','GUEST_PICKUP','REFUND_REQUEST')) IS TRUE)
);
CREATE UNIQUE INDEX restaurant_unique_invoice ON prsystem.restaurant_order_record(merchant_id,invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX restaurant_unique_capture ON prsystem.restaurant_order_record(merchant_id,(state->>'payment_id')) WHERE state->>'payment_id' IS NOT NULL;
CREATE INDEX restaurant_order_stay ON prsystem.restaurant_order_record(tenant_id,stay_id,id);
CREATE INDEX restaurant_order_queue ON prsystem.restaurant_order_record(restaurant_id,created_at,id);
CREATE TABLE prsystem.restaurant_order_event (
 tenant_id text NOT NULL, restaurant_id text NOT NULL, order_id text NOT NULL, revision bigint NOT NULL,
 actor text NOT NULL, action text NOT NULL, before_state jsonb, after_state jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,order_id,revision),
 FOREIGN KEY(tenant_id,order_id) REFERENCES prsystem.restaurant_order_record,
 FOREIGN KEY(restaurant_id,order_id) REFERENCES prsystem.restaurant_order_record(restaurant_id,id)
);
CREATE TABLE prsystem.restaurant_command_receipt (
 scope text NOT NULL, key text NOT NULL, actor text NOT NULL, command jsonb NOT NULL, result jsonb NOT NULL,
 PRIMARY KEY(scope,key)
);
CREATE TRIGGER restaurant_event_immutable BEFORE UPDATE OR DELETE ON prsystem.restaurant_order_event FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE TRIGGER restaurant_receipt_immutable BEFORE UPDATE OR DELETE ON prsystem.restaurant_command_receipt FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
CREATE FUNCTION prsystem.guard_restaurant_order_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable restaurant order'; END IF;
 IF ROW(NEW.tenant_id,NEW.id,NEW.restaurant_id,NEW.stay_id,NEW.merchant_id,NEW.amount_mnt,NEW.items,
        NEW.contact_phone_snapshot,NEW.restaurant_name_snapshot,NEW.room_number_snapshot,NEW.created_at,NEW.expires_at)
 IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.restaurant_id,OLD.stay_id,OLD.merchant_id,OLD.amount_mnt,OLD.items,
        OLD.contact_phone_snapshot,OLD.restaurant_name_snapshot,OLD.room_number_snapshot,OLD.created_at,OLD.expires_at)
 OR (OLD.invoice_id IS NOT NULL AND NEW.invoice_id IS DISTINCT FROM OLD.invoice_id)
 OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'immutable restaurant order snapshot or invalid revision'; END IF;
 IF OLD.state->>'payment'='PAID' AND (NEW.state->>'payment' IS DISTINCT FROM 'PAID'
    OR NEW.state->>'payment_id' IS DISTINCT FROM OLD.state->>'payment_id') THEN RAISE EXCEPTION 'immutable restaurant capture'; END IF;
 IF OLD.state->>'fulfillment' IN ('CANCELLED','DELIVERED_TO_ROOM','HANDED_TO_RECEPTION','PICKED_UP_BY_GUEST')
    AND NEW.state->>'fulfillment' IS DISTINCT FROM OLD.state->>'fulfillment' THEN RAISE EXCEPTION 'terminal restaurant fulfillment'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER restaurant_order_guard BEFORE UPDATE OR DELETE ON prsystem.restaurant_order_record FOR EACH ROW EXECUTE FUNCTION prsystem.guard_restaurant_order_record();
ALTER TABLE prsystem.restaurant_order_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.restaurant_order_record FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_order_scope ON prsystem.restaurant_order_record USING(
 tenant_id=current_setting('prsystem.tenant_id',true) OR restaurant_id=current_setting('prsystem.restaurant_id',true));
ALTER TABLE prsystem.restaurant_order_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.restaurant_order_event FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_event_scope ON prsystem.restaurant_order_event USING(
 tenant_id=current_setting('prsystem.tenant_id',true) OR restaurant_id=current_setting('prsystem.restaurant_id',true));
REVOKE ALL ON prsystem.restaurant_menu_item,prsystem.restaurant_schedule_exception,prsystem.restaurant_order_record,
 prsystem.restaurant_order_event,prsystem.restaurant_command_receipt FROM PUBLIC;

ALTER TABLE prsystem.restaurant_order_record ADD CONSTRAINT restaurant_state_snapshot CHECK(state IS NULL OR (
 state ?& ARRAY['invoice_id','merchant_id','amount_mnt','order','fulfillment','payment','refund_policy','refund_request','refund','handoff']
 AND state->>'invoice_id'=invoice_id AND state->>'merchant_id'=merchant_id
 AND (state->>'amount_mnt')::bigint=amount_mnt
 AND (state->>'created_at')::timestamptz=created_at AND (state->>'expires_at')::timestamptz=expires_at) IS TRUE);
CREATE FUNCTION prsystem.require_restaurant_order_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM prsystem.restaurant_order_event e WHERE e.tenant_id=NEW.tenant_id AND e.order_id=NEW.id
    AND e.revision=NEW.revision AND e.after_state=NEW.state AND e.before_state IS NOT DISTINCT FROM OLD.state) THEN
    RAISE EXCEPTION 'restaurant transition requires immutable event'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER restaurant_order_event_required AFTER UPDATE ON prsystem.restaurant_order_record
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION prsystem.require_restaurant_order_event();
CREATE TABLE prsystem.restaurant_order_handoff (
 tenant_id text NOT NULL, order_id text NOT NULL, stay_id text NOT NULL, actor_id text NOT NULL,
 choice text NOT NULL CHECK(choice IN ('RECEPTION_PICKUP','GUEST_PICKUP','REFUND_REQUEST')),
 guest_informed boolean NOT NULL CHECK(guest_informed), recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,order_id), FOREIGN KEY(tenant_id,order_id) REFERENCES prsystem.restaurant_order_record,
 FOREIGN KEY(tenant_id,stay_id) REFERENCES prsystem.stay,
 FOREIGN KEY(tenant_id,actor_id) REFERENCES prsystem.staff_membership
);
CREATE TRIGGER restaurant_handoff_immutable BEFORE UPDATE OR DELETE ON prsystem.restaurant_order_handoff FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
ALTER TABLE prsystem.restaurant_order_handoff ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.restaurant_order_handoff FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_handoff_scope ON prsystem.restaurant_order_handoff USING(tenant_id=current_setting('prsystem.tenant_id',true));
REVOKE ALL ON prsystem.restaurant_order_handoff FROM PUBLIC;
