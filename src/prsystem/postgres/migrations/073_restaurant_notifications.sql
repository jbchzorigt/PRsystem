CREATE TABLE prsystem.restaurant_notification (
 tenant_id text NOT NULL, restaurant_id text NOT NULL, order_id text NOT NULL,
 code text NOT NULL, audience text NOT NULL CHECK(audience IN ('GUEST','RESTAURANT','RECEPTION','MANAGER_PLUS')),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,order_id,code,audience),
 FOREIGN KEY(tenant_id,order_id) REFERENCES prsystem.restaurant_order_record,
 FOREIGN KEY(restaurant_id,order_id) REFERENCES prsystem.restaurant_order_record(restaurant_id,id)
);
CREATE TRIGGER restaurant_notification_immutable BEFORE UPDATE OR DELETE ON prsystem.restaurant_notification
 FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
ALTER TABLE prsystem.restaurant_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.restaurant_notification FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_notification_scope ON prsystem.restaurant_notification USING(
 tenant_id=current_setting('prsystem.tenant_id',true) OR restaurant_id=current_setting('prsystem.restaurant_id',true));
REVOKE ALL ON prsystem.restaurant_notification FROM PUBLIC;
CREATE INDEX restaurant_notifications_tenant ON prsystem.restaurant_notification(tenant_id,(order_id||':'||code||':'||audience));
CREATE INDEX restaurant_notifications_venue ON prsystem.restaurant_notification(restaurant_id,(order_id||':'||code||':'||audience));
CREATE TABLE prsystem.restaurant_worker_cursor (
 tenant_id text NOT NULL,order_id text NOT NULL,restaurant_id text NOT NULL,checked_at timestamptz NOT NULL,
 PRIMARY KEY(tenant_id,order_id),FOREIGN KEY(tenant_id,order_id) REFERENCES prsystem.restaurant_order_record,
 FOREIGN KEY(restaurant_id,order_id) REFERENCES prsystem.restaurant_order_record(restaurant_id,id)
);
ALTER TABLE prsystem.restaurant_worker_cursor ENABLE ROW LEVEL SECURITY;
ALTER TABLE prsystem.restaurant_worker_cursor FORCE ROW LEVEL SECURITY;
CREATE POLICY restaurant_worker_scope ON prsystem.restaurant_worker_cursor USING(
 tenant_id=current_setting('prsystem.tenant_id',true) OR restaurant_id=current_setting('prsystem.restaurant_id',true));
REVOKE ALL ON prsystem.restaurant_worker_cursor FROM PUBLIC;
