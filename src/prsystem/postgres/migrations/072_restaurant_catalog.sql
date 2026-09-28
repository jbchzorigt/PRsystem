ALTER TABLE prsystem.restaurant_menu_item ADD COLUMN image_data text
 CHECK(image_data IS NULL OR (length(image_data)<=400000 AND image_data LIKE 'data:image/jpeg;base64,%'));

CREATE TABLE prsystem.restaurant_configuration_event (
 restaurant_id text NOT NULL REFERENCES prsystem.restaurant, revision bigint NOT NULL,
 actor_id text NOT NULL REFERENCES prsystem.staff_account, reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 1000),
 before_snapshot jsonb NOT NULL, after_snapshot jsonb NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(restaurant_id,revision)
);
CREATE TRIGGER restaurant_configuration_event_immutable BEFORE UPDATE OR DELETE ON prsystem.restaurant_configuration_event
 FOR EACH ROW EXECUTE FUNCTION prsystem.reject_history_mutation();
REVOKE ALL ON prsystem.restaurant_configuration_event FROM PUBLIC;
